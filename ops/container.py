#!/usr/bin/env python3
"""Portable single-writer launcher and SQLite operations for Compose/Kubernetes."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.request import urlopen
from sqlite_ops import snapshot, db_check, restore_file, atomic_json, stamp, verify, operation_status

os.umask(0o077)
DATA = Path(os.environ.get('DATA_DIR', '/data')).resolve()
BACKUPS = Path(os.environ.get('BACKUP_DIR', '/backups')).resolve()
NODE = os.environ.get('NODE_BINARY', 'node')
SOURCE = Path(__file__).resolve().parent.parent

@contextmanager
def lock(name):
    DATA.mkdir(parents=True, exist_ok=True)
    with (DATA / name).open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another operation or application writer is running. Stop the application before restore.')
        yield


def status(**changes):
    operation_status({'data': str(DATA)}, **changes)


def backup(kind='scheduled'):
    BACKUPS.mkdir(parents=True, exist_ok=True)
    with lock('backup.lock'):
        try:
            target = BACKUPS / f'{kind}-{stamp()}.sqlite'
            snapshot(DATA / 'workspaces.sqlite', target)
            status(backup_last_success=time.time(), backup_last_attempt_success=1)
            if kind == 'scheduled':
                retention = int(os.environ.get('BACKUP_RETENTION', '14'))
                if retention < 1:
                    raise RuntimeError('BACKUP_RETENTION must be positive.')
                for old in sorted(BACKUPS.glob('scheduled-*.sqlite'), reverse=True)[retention:]:
                    old.unlink()
            print(f'Backup verified: {target}', flush=True)
            return target
        except Exception:
            status(backup_last_attempt_success=0)
            raise


def drill(path):
    # Clone SQLite and boot this actual application
    # against a disposable loopback directory. It never replaces live data.
    from tempfile import TemporaryDirectory
    with TemporaryDirectory(prefix='workspaces-drill-') as temp:
        root = Path(temp)
        release = root / 'releases' / 'container-drill'
        release.mkdir(parents=True)
        for name in ('server', 'shared', 'node_modules', 'dist'):
            (release / name).symlink_to(SOURCE / name, target_is_directory=True)
        (release / 'package.json').symlink_to(SOURCE / 'package.json')
        # A symlinked server entry imports source dependencies but uses the private cwd/data.
        schema = int(subprocess.check_output([NODE, '--import', 'tsx', '--input-type=module', '-e', "import { DATABASE_VERSION } from './server/store.ts'; console.log(DATABASE_VERSION)"], cwd=SOURCE, text=True))
        atomic_json(release / 'release.json', {'id': release.name, 'schema': schema})
        verify(root, {'node': NODE, 'data': str(DATA), 'port': 4310, 'origin': 'http://127.0.0.1:4310'}, release, path.resolve(), temporary_directory=DATA)


def serve():
    with lock('writer.lock'):
        # Check release compatibility and save a rescue point before automatic schema migration.
        database = DATA / 'workspaces.sqlite'
        if database.exists():
            schema = int(subprocess.check_output([NODE, '--import', 'tsx', '--input-type=module', '-e', "import { DATABASE_VERSION } from './server/store.ts'; console.log(DATABASE_VERSION)"], cwd=SOURCE, text=True))
            current = db_check(database)
            if current > schema:
                raise RuntimeError('Database is newer than this image. Restore a compatible backup explicitly before downgrading.')
            if current < schema:
                saved = backup('before-upgrade')
                drill(saved)
        child = subprocess.Popen([NODE, '--import', 'tsx', 'server/index.ts'], cwd=SOURCE)
        def stop(signum, _frame):
            if child.poll() is None:
                child.send_signal(signum)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        sys.exit(child.wait())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['serve','health','backup','backup-loop','verify-backup','restore'])
    parser.add_argument('path', nargs='?', type=Path)
    parser.add_argument('--confirm-restore', action='store_true')
    args = parser.parse_args()
    if args.command == 'serve':
        serve()
    elif args.command == 'health':
        with urlopen(f'http://127.0.0.1:{os.environ.get("PORT", "4310")}/readyz', timeout=5) as response:
            if not json.load(response)['ok']:
                raise RuntimeError('Application is not ready.')
    elif args.command == 'backup':
        backup('manual')
    elif args.command == 'backup-loop':
        interval = int(os.environ.get('BACKUP_INTERVAL_SECONDS', '86400'))
        if interval < 60:
            raise RuntimeError('BACKUP_INTERVAL_SECONDS must be at least 60.')
        while True:
            delay = interval
            try:
                backup()
            except Exception as error:
                print(f'Backup failed: {error}', file=sys.stderr, flush=True)
                delay = 60
            time.sleep(delay)
    elif args.command == 'verify-backup':
        if args.path is None:
            raise RuntimeError('Select a backup file.')
        drill(args.path)
    elif args.command == 'restore':
        if not args.path or not args.confirm_restore:
            raise RuntimeError('Select a backup and pass --confirm-restore. This replaces current data.')
        with lock('writer.lock'):
            drill(args.path)
            if (DATA / 'workspaces.sqlite').exists():
                backup('before-restore')
            with lock('backup.lock'):
                restore_file(args.path.resolve(), DATA)
            print('Restore complete. Start the application and check readiness.')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'Operation failed: {error}', file=sys.stderr)
        sys.exit(1)
