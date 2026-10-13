import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { Store } from '../server/store.ts';
import { tenantId } from './oidc-provider.ts';

test('server startup accepts OIDC secret files and legacy Entra, enforces SSO, and rejects ambiguous configuration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-oidc-config-'));
  const store = new Store(join(directory, 'workspaces.sqlite'));
  const owner = {
    name: 'Owner',
    email: 'owner@example.test',
    password: 'configuration-password-1234',
  };
  await store.setup(owner);
  store.close();
  const secretFile = join(directory, 'client-secret');
  writeFileSync(secretFile, 'configuration-secret\n', { mode: 0o600 });
  const probe = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => probe.once('listening', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: directory,
    APP_ORIGIN: 'https://checkpoint.example.test',
    AUTH_MODE: 'optional',
    TRUSTED_PROXIES: '',
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith('OIDC_') ||
      key.startsWith('ENTRA_') ||
      key.startsWith('METRICS_TOKEN')
    )
      delete env[key];
  const oidc = {
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://identity.example.test/realms/engineering',
    OIDC_CLIENT_ID: 'checkpoint-web',
    OIDC_CLIENT_SECRET_FILE: secretFile,
    OIDC_SCOPES: 'openid profile email groups',
    OIDC_PROMPT: '',
    OIDC_LOGOUT_REDIRECT: 'true',
  };
  const legacy = {
    AUTH_MODE: 'entra',
    ENTRA_TENANT_ID: tenantId,
    ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    ENTRA_CLIENT_SECRET_FILE: secretFile,
  };
  const args = ['--import', 'tsx', 'server/index.ts'];
  try {
    for (const settings of [{}, oidc, legacy]) {
      const child = spawn(process.execPath, args, {
        env: { ...env, ...settings },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs = '';
      child.stdout.on('data', (chunk) => {
        logs += chunk;
      });
      child.stderr.on('data', (chunk) => {
        logs += chunk;
      });
      const stopped = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      try {
        let ready = false;
        for (
          let attempt = 0;
          attempt < 100 && child.exitCode === null;
          attempt++
        ) {
          try {
            ready = (await fetch(base + '/livez')).ok;
          } catch {}
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(ready, logs);
        const status = await (await fetch(base + '/api/auth/status')).json();
        assert.equal(status.oidcEnabled, 'AUTH_MODE' in settings);
        assert.equal(status.requireSso, 'AUTH_MODE' in settings);
        const login = await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: {
            Origin: env.APP_ORIGIN!,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(owner),
        });
        assert.equal(login.status, 'AUTH_MODE' in settings ? 403 : 200);
        // Provider return navigation loads only the public shell; API reads remain protected.
        const headers = {
          'Sec-Fetch-Site': 'cross-site',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        };
        const navigation = (path: string) =>
          new Promise<number | undefined>((resolve, reject) => {
            get(base + path, { headers }, (response) => {
              response.resume();
              resolve(response.statusCode);
            }).on('error', reject);
          });
        assert.notEqual(await navigation('/'), 403);
        assert.equal(await navigation('/api/workspaces'), 403);
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM');
        await stopped;
      }
    }
    for (const [settings, message] of [
      [{ ...oidc, ...legacy }, /Do not mix/],
      [{ ...legacy, OIDC_CLIENT_SECRET_FILE: secretFile }, /Do not mix/],
      [{ ...oidc, OIDC_CLIENT_SECRET: 'second-secret' }, /Set either/],
      [{ ...oidc, OIDC_SCOPES: 'profile email' }, /must include openid/],
      [
        { ...oidc, OIDC_ISSUER: 'http://identity.example.test' },
        /HTTPS issuer/,
      ],
      [{ ...oidc, OIDC_LOGOUT_REDIRECT: 'yes' }, /must be true or false/],
    ] as const) {
      const result = spawnSync(process.execPath, args, {
        env: { ...env, ...settings },
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, message);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
