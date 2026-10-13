import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { digest } from '../server/security.ts';
import { tenantId } from './oidc-provider.ts';

test('schema upgrade preserves Entra links and sessions; verified issuer/subject migration is atomic and never matches email', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-oidc-migration-'));
  const filename = join(directory, 'db.sqlite');
  let store = new Store(filename);
  try {
    const owner = {
      user: await store.setup({
        name: 'Owner',
        email: 'owner@example.test',
        password: 'migration-password-1234',
      }),
    };
    const workspace = store.workspaces(owner)[0];
    const colleague = await store.register({
      name: 'Colleague',
      email: 'colleague@example.test',
      password: 'migration-password-1234',
      invitation: store.invite(owner, workspace.id, { role: 'viewer' }).token,
    });
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const objectId = '33333333-3333-4333-8333-333333333333';
    store.db
      .prepare('INSERT INTO identities VALUES(?,?,?)')
      .run(tenantId, objectId, owner.user.id);
    const oldSession = store.session(owner.user, 'entra');
    // Recreate the pre-upgrade identity schema, with real persisted links and sessions.
    store.db.exec(
      `DROP TABLE oidc_identities; ALTER TABLE sessions DROP COLUMN oidc_issuer; ALTER TABLE sessions DROP COLUMN oidc_id_token; PRAGMA user_version=12;`,
    );
    store.close();
    store = new Store(filename);
    assert.equal(store.sessionActor(oldSession, true)?.user.id, owner.user.id);
    assert.equal(store.identityStatus(owner, issuer).linked, true);
    const flow = { userId: null, sessionHash: null, invitation: null };
    const identity = {
      issuer,
      subject: 'pairwise-subject-not-object-id',
      legacyEntra: { tenantId, objectId },
    };
    // Another provider cannot impersonate a historical Entra identity with tid/oid claims.
    await assert.rejects(
      store.oidcSignIn(
        {
          ...identity,
          issuer: 'https://other.example',
          email: owner.user.email,
        },
        flow,
      ),
      /invitation/,
    );
    assert.equal((await store.oidcSignIn(identity, flow)).id, owner.user.id);
    assert.equal(
      (await store.oidcSignIn({ issuer, subject: identity.subject }, flow)).id,
      owner.user.id,
    );
    assert.equal(
      store.db.prepare('SELECT COUNT(*) n FROM identities').get()?.n,
      1,
    );
    assert.equal(
      store.db.prepare('SELECT COUNT(*) n FROM oidc_identities').get()?.n,
      1,
    );
    // A changed pairwise subject cannot silently overwrite the mapping.
    await assert.rejects(
      store.oidcSignIn({ ...identity, subject: 'changed-subject' }, flow),
      /already has an identity/,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) n FROM audit_log WHERE action='identity.linked'",
        )
        .get()?.n,
      1,
    );
    // A provider switch requires a live, explicitly authorized local linking session.
    const other = {
      issuer: 'https://other.example',
      subject: identity.subject,
    };
    assert.equal(store.identityStatus(owner, other.issuer).linked, false);
    const local = store.session(owner.user);
    const linking = {
      ...flow,
      userId: owner.user.id,
      sessionHash: digest(local),
    };
    assert.equal((await store.oidcSignIn(other, linking)).id, owner.user.id);
    assert.equal(store.identityStatus(owner, other.issuer).linked, true);
    const colleagueSession = store.session(colleague);
    await assert.rejects(
      store.oidcSignIn(other, {
        ...flow,
        userId: colleague.id,
        sessionHash: digest(colleagueSession),
      }),
      /already linked/,
    );
    store.logout(local);
    await assert.rejects(
      store.oidcSignIn(
        { issuer: 'https://third.example', subject: 'new' },
        linking,
      ),
      /Sign in again/,
    );
    // Contradictory historical and new links fail closed without changing either user.
    store.db
      .prepare('INSERT INTO oidc_identities VALUES(?,?,?)')
      .run(issuer, 'conflicting-subject', colleague.id);
    await assert.rejects(
      store.oidcSignIn({ ...identity, subject: 'conflicting-subject' }, flow),
      /links conflict/,
    );
    store.offboard(owner, colleague.id, {
      expectedVersion: store.organization(owner).version,
    });
    await assert.rejects(
      store.oidcSignIn({ issuer, subject: 'conflicting-subject' }, flow),
      /unavailable/,
    );
    store.close();
    store = new Store(filename);
    assert.equal((await store.oidcSignIn(other, flow)).id, owner.user.id);
    assert.equal(
      store.db.prepare('PRAGMA integrity_check').get()?.integrity_check,
      'ok',
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
