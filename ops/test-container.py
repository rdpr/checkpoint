#!/usr/bin/env python3
"""Disposable Docker Compose smoke/restore acceptance. Never mounts host application data."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

source = Path(__file__).resolve().parent.parent
subprocess.run(['docker', 'info'], check=True, stdout=subprocess.DEVNULL)
with tempfile.TemporaryDirectory(prefix='pw-compose-test-') as temporary:
    directory = Path(temporary)
    grafana_password = secrets.token_urlsafe(32)
    for name, value in [('entra', ''), ('metrics', secrets.token_urlsafe(32)), ('grafana', grafana_password)]:
        (directory / name).write_text(value)
        (directory / name).chmod(0o444)  # Disposable test credentials; real installs restrict access.
    env = dict(os.environ, APP_ORIGIN='https://workspaces.example.test', APP_PORT='0',
               CHECKPOINT_IMAGE=os.environ.get('TEST_IMAGE', f'workspaces-test:{os.getpid()}'), AUTH_MODE='optional',
               ENTRA_TENANT_ID='', ENTRA_CLIENT_ID='', ENTRA_SECRET_FILE=str(directory / 'entra'),
               METRICS_SECRET_FILE=str(directory / 'metrics'), GRAFANA_PASSWORD_FILE=str(directory / 'grafana'), GRAFANA_PORT='0')
    command = ['docker', 'compose', '-p', f'pw-test-{os.getpid()}', '-f', str(source / 'deploy/compose/compose.yaml'), '-f', str(source / 'deploy/compose/monitoring.yaml')]
    def compose(*args, **kwargs):
        return subprocess.run(command + list(args), env=env, check=True, text=True, **kwargs)
    try:
        if 'TEST_IMAGE' not in os.environ:
            subprocess.run(['docker', 'build', '-t', env['CHECKPOINT_IMAGE'], str(source)], check=True)
        compose('up', '-d', 'app')
        port = compose('port', 'app', '4310', capture_output=True).stdout.strip().rsplit(':', 1)[1]
        base = f'http://127.0.0.1:{port}'
        def get(path):
            with urlopen(Request(base + path, headers={'Host': 'workspaces.example.test'}), timeout=5) as response:
                return response.read()
        for _ in range(60):
            try:
                get('/livez')
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('Container did not start.')
        compose('exec', '-T', 'app', 'node', '--import', 'tsx', 'server/operator.ts', 'bootstrap', input=json.dumps({'name': 'Test owner', 'email': 'compose@example.test', 'password': secrets.token_urlsafe(24)}))
        assert json.loads(get('/readyz'))['ok']
        assert b'<html' in get('/')
        compose('exec', '-T', 'app', 'python3', 'ops/container.py', 'backup')
        result = compose('exec', '-T', 'app', 'python3', '-c', "from pathlib import Path; print(next(Path('/backups').glob('manual-*.sqlite')))", capture_output=True)
        backup = result.stdout.strip()
        compose('exec', '-T', 'app', 'python3', 'ops/container.py', 'verify-backup', backup)
        compose('stop', 'app')
        compose('run', '--rm', '--no-deps', 'app', 'restore', backup, '--confirm-restore')
        compose('up', '-d', '--wait', 'app')
        compose('up', '-d', 'backup')
        compose('exec', '-T', 'app', 'python3', '-c', "from pathlib import Path; import time; p=Path('/backups'); deadline=time.monotonic()+30\nwhile not list(p.glob('scheduled-*.sqlite')) and time.monotonic()<deadline: time.sleep(1)\nassert list(p.glob('scheduled-*.sqlite')), 'Scheduled backup did not run'")
        port = compose('port', 'app', '4310', capture_output=True).stdout.strip().rsplit(':', 1)[1]
        base = f'http://127.0.0.1:{port}'
        assert json.loads(get('/readyz'))['ok']
        compose('up', '-d', 'prometheus', 'grafana')
        grafana_port = compose('port', 'grafana', '3000', capture_output=True).stdout.strip().rsplit(':', 1)[1]
        grafana = f'http://127.0.0.1:{grafana_port}'
        authorization = 'Basic ' + base64.b64encode(('admin:' + grafana_password).encode()).decode()
        def dashboard_get(path):
            with urlopen(Request(grafana + path, headers={'Authorization': authorization}), timeout=5) as response:
                return json.load(response)
        for _ in range(90):
            try:
                result = dashboard_get('/api/datasources/proxy/uid/workspaces-prometheus/api/v1/query?query=up%7Bjob%3D%22workspaces%22%7D')
                if result['data']['result'][0]['value'][1] == '1':
                    break
            except Exception:
                pass
            time.sleep(1)
        else:
            raise RuntimeError('Grafana could not query a successful authenticated Prometheus scrape.')
        assert dashboard_get('/api/search?type=dash-db'), 'Provisioned dashboard not found'
        print('Compose startup, scheduled backup, restore, restart, Grafana dashboard and authenticated Prometheus scrape passed.')
    finally:
        compose('down', '--volumes', '--remove-orphans')
