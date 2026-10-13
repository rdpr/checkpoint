import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { Store } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { Oidc } from '../server/oidc.ts';
import { identityProvider, clientId } from './oidc-provider.ts';

test('OIDC HTTP flow links explicitly, validates signed claims, accepts invitations, and respects recovery and offboarding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-identity-'));
  let store = new Store(join(directory, 'workspaces.sqlite'));
  const provider = await identityProvider();
  const ownerInput = {
    name: 'Alex Morgan',
    email: 'alex@example.test',
    password: 'identity-password-1234',
  };
  const owner = { user: await store.setup(ownerInput) };
  const workspace = store.workspaces(owner)[0];
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const options = {
    origins: [base],
    serveStatic: false,
    requireSso: false,
    oidc: new Oidc({
      clientId,
      clientSecret: 'fixture-secret',
      origin: base,
      issuer: provider.issuer.href.slice(0, -1),
      allowInsecureRequests: true,
      logoutRedirect: true,
    }),
  };
  server.on('request', createApp(store, options));
  const request = (path: string, cookie = '', body?: unknown) =>
    fetch(base + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        Origin: base,
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const cookie = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((s) => s.startsWith('pw_session='))
      ?.split(';')[0] ?? '';
  const start = async (body = {}, session = '') => {
    const response = await request('/api/auth/oidc/start', session, body);
    assert.equal(response.status, 200, await response.clone().text());
    const url = (await response.json()).url;
    const authorized = await fetch(url, { redirect: 'manual' });
    return {
      callback: authorized.headers.get('location')!,
      cookie: response.headers.getSetCookie()[0].split(';')[0],
    };
  };
  const finish = (flow: { callback: string; cookie: string }) =>
    fetch(flow.callback, {
      redirect: 'manual',
      headers: { Cookie: flow.cookie, 'Sec-Fetch-Site': 'cross-site' },
    });
  try {
    const noLink = await finish(await start());
    assert.match(noLink.headers.get('location')!, /signinError=/);
    assert.equal(cookie(noLink), '');
    assert.equal(
      provider.requests.authorization?.searchParams.get('scope'),
      'openid profile email',
    );
    assert.equal(
      provider.requests.authorization?.searchParams.has('prompt'),
      false,
    );
    const login = await request('/api/auth/login', '', ownerInput),
      local = cookie(login);
    assert.ok(local);
    const flow = await start(
      { mode: 'link', password: ownerInput.password },
      local,
    );
    assert.match(
      (await finish({ ...flow, cookie: 'pw_oidc=other-browser' })).headers.get(
        'location',
      )!,
      /signinError/,
    );
    // A restart between authorization and callback preserves the one-use, browser-bound flow.
    server.removeAllListeners('request');
    store.close();
    store = new Store(join(directory, 'workspaces.sqlite'));
    server.on('request', createApp(store, options));
    const linked = await finish(flow),
      sso = cookie(linked);
    assert.equal(linked.headers.get('location'), '/');
    assert.ok(sso);
    assert.match((await finish(flow)).headers.get('location')!, /signinError/);
    assert.deepEqual(await (await request('/api/auth/identity', sso)).json(), {
      linked: true,
      enabled: true,
    });
    for (const [field, value] of [
      ['iss', 'https://wrong-issuer.example'],
      ['aud', 'wrong-audience'],
      ['nonce', 'wrong-nonce'],
    ]) {
      const previous = provider.claims[field];
      provider.claims[field] = value;
      assert.equal(cookie(await finish(await start())), '', field);
      if (previous === undefined) delete provider.claims[field];
      else provider.claims[field] = previous;
    }
    const subject = provider.claims.sub;
    delete provider.claims.sub;
    assert.equal(cookie(await finish(await start())), '');
    provider.claims.sub = subject;
    // Neither display claims nor Entra-looking claims define a generic identity.
    provider.claims.email = 'changed@example.test';
    provider.claims.oid = 'some-other-object';
    provider.claims.tid = 'some-other-tenant';
    const stable = await finish(await start());
    assert.equal(
      (await (await request('/api/auth/status', cookie(stable))).json()).user
        .id,
      owner.user.id,
    );
    provider.claims.email = ownerInput.email;
    options.oidc = new Oidc({
      ...options.oidc.options,
      scopes: 'openid email custom:review',
      prompt: 'login',
    });
    assert.ok(cookie(await finish(await start())));
    assert.equal(
      provider.requests.authorization?.searchParams.get('scope'),
      'openid email custom:review',
    );
    assert.equal(
      provider.requests.authorization?.searchParams.get('prompt'),
      'login',
    );
    // Same subject from another issuer must not find the existing identity.
    const otherProvider = await identityProvider();
    const configured = options.oidc;
    try {
      options.oidc = new Oidc({
        ...configured.options,
        issuer: otherProvider.issuer.href.slice(0, -1),
      });
      assert.equal(cookie(await finish(await start())), '');
      assert.equal(
        (await (await request('/api/auth/identity', sso)).json()).linked,
        false,
      );
    } finally {
      options.oidc = configured;
      await otherProvider.close();
    }
    // Logout removes the session before returning an RP-Initiated Logout URL.
    const signedOut = await (
      await request('/api/auth/logout', cookie(stable), {})
    ).json();
    assert.equal(
      (await request('/api/workspaces', cookie(stable))).status,
      401,
    );
    const logoutUrl = new URL(signedOut.url);
    assert.equal(logoutUrl.origin, provider.issuer.origin);
    assert.equal(
      logoutUrl.searchParams.get('post_logout_redirect_uri'),
      base + '/',
    );
    assert.ok(logoutUrl.searchParams.get('id_token_hint'));
    assert.equal(logoutUrl.searchParams.get('client_id'), clientId);
    assert.equal(
      (await fetch(logoutUrl, { redirect: 'manual' })).headers.get('location'),
      base + '/',
    );
    // A discovery outage cannot prevent local logout, and password logout stays local.
    const temporary = cookie(await finish(await start()));
    options.oidc = new Oidc(configured.options);
    provider.behavior.unavailable = true;
    assert.deepEqual(
      await (await request('/api/auth/logout', temporary, {})).json(),
      { ok: true },
    );
    assert.equal((await request('/api/workspaces', temporary)).status, 401);
    provider.behavior.unavailable = false;
    options.oidc = configured;
    const passwordSession = cookie(
      await request('/api/auth/login', '', ownerInput),
    );
    assert.deepEqual(
      await (await request('/api/auth/logout', passwordSession, {})).json(),
      { ok: true },
    );
    provider.behavior.corruptSignature = true;
    assert.equal(cookie(await finish(await start())), '');
    provider.behavior.corruptSignature = false;
    // Enforcement invalidates existing password sessions, retaining verified SSO sessions.
    options.requireSso = true;
    assert.equal((await request('/api/workspaces', local)).status, 401);
    assert.equal((await request('/api/workspaces', sso)).status, 200);
    assert.equal(
      (await request('/api/auth/login', '', ownerInput)).status,
      403,
    );
    const invitation = store.invite(owner, workspace.id, { role: 'viewer' });
    provider.claims.sub = '55555555-5555-4555-8555-555555555555';
    // Same email with another identity cannot take over an existing account through an invite.
    assert.equal(
      cookie(await finish(await start({ invitation: invitation.token }))),
      '',
    );
    provider.claims.email = 'colleague@example.test';
    provider.claims.name = 'Colleague';
    const joined = await finish(await start({ invitation: invitation.token })),
      colleagueCookie = cookie(joined);
    assert.ok(colleagueCookie);
    const colleague = (
      await (await request('/api/auth/status', colleagueCookie)).json()
    ).user;
    assert.equal(
      (await (await request('/api/workspaces', colleagueCookie)).json()).length,
      1,
    );
    store.offboard(owner, colleague.id, {
      expectedVersion: store.organization(owner).version,
    });
    assert.equal(
      (await request('/api/workspaces', colleagueCookie)).status,
      401,
    );
    assert.equal(cookie(await finish(await start())), '');
    const key = store.createToken(owner, workspace.id, {
      name: 'recovery key',
      scope: 'read',
    });
    const recovered = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'server/operator.ts', 'recover-admin'],
      {
        env: { ...process.env, DATA_DIR: directory },
        input: JSON.stringify({
          ...ownerInput,
          password: 'new-recovery-password-1234',
          reason: 'Identity provider outage',
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal((await request('/api/workspaces', sso)).status, 401);
    assert.equal(store.tokenActor(key.token), undefined);
    const recovery = cookie(
      await request('/api/auth/login', '', {
        email: ownerInput.email,
        password: 'new-recovery-password-1234',
      }),
    );
    assert.ok(recovery);
    store.db
      .prepare("UPDATE users SET recovery_until='2000-01-01T00:00:00.000Z'")
      .run();
    assert.equal((await request('/api/workspaces', recovery)).status, 401);
    assert.ok(
      store.db
        .prepare("SELECT id FROM audit_log WHERE action='account.recovered'")
        .get(),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await provider.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('health and bearer-protected metrics expose operational failures without artifact or user labels', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-metrics-'));
  const store = new Store(join(directory, 'db.sqlite'));
  const operationsFile = join(directory, 'operations.json');
  const secret = 'metrics-secret-that-is-at-least-32-characters';
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    createApp(store, {
      origins: [base],
      serveStatic: false,
      metricsToken: secret,
      dataDir: directory,
      operationsFile,
    }),
  );
  try {
    assert.equal((await fetch(base + '/livez')).status, 200);
    assert.equal((await fetch(base + '/readyz')).status, 503);
    await store.setup({
      name: 'Private Name',
      email: 'private@example.test',
      password: 'a-secure-password-1234',
    });
    assert.equal((await fetch(base + '/readyz')).status, 200);
    assert.equal((await fetch(base + '/metrics')).status, 401);
    assert.equal(
      (await fetch(base + '/metrics', { headers: { Authorization: secret } }))
        .status,
      401,
    );
    const scrape = async () =>
      (
        await fetch(base + '/metrics', {
          headers: { Authorization: `Bearer ${secret}` },
        })
      ).text();
    assert.match(await scrape(), /workspaces_operations_status_readable 0/);
    writeFileSync(
      operationsFile,
      JSON.stringify({
        backup_last_success: 123456,
        backup_last_attempt_success: 1,
        restore_drill_last_success: 123400,
      }),
    );
    await fetch(base + '/api/artifacts/private-artifact-id');
    const metrics = await scrape();
    assert.match(
      metrics,
      /workspaces_backup_last_success_timestamp_seconds 123456/,
    );
    assert.match(metrics, /workspaces_offsite_backup_configured 0/);
    assert.match(metrics, /area="api"/);
    assert.doesNotMatch(
      metrics,
      /private-artifact-id|Private Name|private@example/,
    );
    store.close();
    assert.equal((await fetch(base + '/readyz')).status, 503);
    assert.match(await scrape(), /workspaces_database_up 0/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
