"""SQLite snapshots and isolated restore verification for container deployments."""
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen
os.umask(0o077)


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as out:
        json.dump(value, out, indent=2)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
    sync_dir(path.parent)

def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def read_json(path):
    return json.loads(path.read_text())

def stamp():
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')

def db_check(path):
    if not path.is_file():
        raise RuntimeError(f'Database not found: {path}')
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError(f'SQLite integrity check failed: {path}')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise RuntimeError(f'SQLite foreign key check failed: {path}')
        # Catch accidentally selected empty/unrelated databases before touching live data.
        artifact_table = 'artifacts' if db.execute('PRAGMA user_version').fetchone()[0] >= 12 else 'documents'
        for table in ('users', artifact_table, 'revisions', 'comments', 'reviews'):
            db.execute(f'SELECT count(*) FROM {table}').fetchone()
        return db.execute('PRAGMA user_version').fetchone()[0]

def snapshot(source, destination):
    db_check(source)
    temporary = destination.with_suffix('.partial')
    try:
        with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
            with sqlite3.connect(temporary) as dst:
                src.backup(dst)
                # Self-contained file: no dependency on source or backup WAL sidecars.
                dst.execute('PRAGMA journal_mode=DELETE')
        db_check(temporary)
        with temporary.open('rb') as data:
            os.fsync(data.fileno())
        os.replace(temporary, destination)
        sync_dir(destination.parent)
    finally:
        temporary.unlink(missing_ok=True)

def operation_status(config, **changes):
    path = Path(config['data']) / 'operations.json'
    with (path.parent / 'status.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            previous = read_json(path) if path.exists() else {}
            if not isinstance(previous, dict):
                previous = {}
        except (ValueError, OSError):
            previous = {}
        atomic_json(path, {**previous, **changes})

def restore_file(source, data):
    # Caller holds the operation lock and has fully stopped the service.
    staged = data / 'restore.sqlite'
    snapshot(source, staged)
    for suffix in ('-wal', '-shm'):
        (data / ('workspaces.sqlite' + suffix)).unlink(missing_ok=True)
    os.replace(staged, data / 'workspaces.sqlite')
    sync_dir(data)

def release_info(root, release):
    release = release.resolve()
    if release.parent != (root / 'releases').resolve() or not release.is_dir():
        raise RuntimeError('Choose a prepared release inside this installation’s releases directory.')
    info = read_json(release / 'release.json')
    if info['id'] != release.name or not (release / 'dist/index.html').is_file():
        raise RuntimeError('Release is incomplete or its identity does not match.')
    return info

def environment(config, release, data, port=None, maintenance=None):
    env = os.environ.copy()
    env.update(NODE_ENV='production', HOST='127.0.0.1', PORT=str(port or config['port']),
               APP_ORIGIN=f'http://127.0.0.1:{port}' if port else config['origin'],
               DATA_DIR=str(data), APP_RELEASE=release.name,
               OPERATIONS_STATUS_FILE=str(data / 'operations.json'))
    if port:
        env['AUTH_MODE'] = 'optional'
        for key in list(env):
            if key.startswith('ENTRA_') or key.startswith('METRICS_TOKEN'):
                env.pop(key, None)
    env.pop('MAINTENANCE_FILE', None)
    if maintenance:
        env['MAINTENANCE_FILE'] = str(maintenance)
    return env

def http_check(base, release, allow_maintenance=False):
    with urlopen(base + '/api/health', timeout=5) as response:
        health = json.load(response)
    if not health.get('ok') or health.get('release') != release.name:
        raise RuntimeError(f'Unexpected health response from {base}: {health}')
    if health.get('maintenance') and not allow_maintenance:
        raise RuntimeError('Workspace is in maintenance mode.')
    with urlopen(base + '/', timeout=5) as response:
        html = response.read().decode()
    match = re.search(r'<script[^>]+src="(/assets/[^\"]+)"', html)
    if not match:
        raise RuntimeError('Built frontend entry is missing.')
    with urlopen(base + match[1], timeout=5) as response:
        if 'javascript' not in response.headers.get('Content-Type', ''):
            raise RuntimeError('Frontend asset could not be loaded.')
        response.read(128)
    return health

def wait_healthy(config, release, port=None, process=None):
    end = time.monotonic() + 30
    last = None
    while time.monotonic() < end:
        if process and process.poll() is not None:
            raise RuntimeError(f'Release exited during verification ({process.returncode}).')
        try:
            return http_check(f'http://127.0.0.1:{port or config["port"]}', release, True)
        except Exception as error:
            last = error
            time.sleep(.25)
    raise RuntimeError(f'Release did not become healthy: {last}')

def verify(root, config, release, source, temporary_directory=None):
    info = release_info(root, release)
    if db_check(source) > info['schema']:
        raise RuntimeError('This release cannot read the newer database schema. Keep the current release or explicitly restore a compatible backup.')
    # A restore drill starts the real release on a private COPY, never on live data.
    with tempfile.TemporaryDirectory(prefix='pw-restore-', dir=temporary_directory) as directory:
        data = Path(directory)
        snapshot(source, data / 'workspaces.sqlite')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        with (data / 'server.log').open('w+') as log:
            process = subprocess.Popen([config['node'], '--import', 'tsx', 'server/index.ts'],
                                       cwd=release, env=environment(config, release, data, port),
                                       stdout=log, stderr=log, start_new_session=True)
            try:
                wait_healthy(config, release, port, process)
                db_check(data / 'workspaces.sqlite')
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read()[-4000:], file=sys.stderr)
                raise
            finally:
                os.killpg(process.pid, signal.SIGTERM) if process.poll() is None else None
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
    operation_status(config, restore_drill_last_success=time.time())
    print(f'Restore drill passed: {source.name} with {release.name}', flush=True)
