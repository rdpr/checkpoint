import { legacyNames } from './legacy-schema.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Actor } from '../server/store.ts';
import { AppError } from '../server/security.ts';

const ownerInput = {
  name: 'Alex',
  email: 'alex@example.test',
  password: 'test-password-1234',
};
const fails = (code: string) => (e: unknown) =>
  e instanceof AppError && e.code === code;
async function fixture() {
  const store = new Store(':memory:');
  const owner: Actor = { user: await store.setup(ownerInput) };
  const workspace = store.workspaces(owner)[0];
  const artifact = store.artifact(
    owner,
    store.artifacts(owner, workspace.id)[0].id,
  );
  return { store, owner, workspace, artifact };
}

test('two editors and an agent cannot overwrite a newer revision; restore preserves history', async () => {
  const { store, owner, workspace, artifact } = await fixture();
  try {
    const invitation = store.invite(owner, workspace.id, { role: 'editor' });
    const editor = {
      user: await store.register({
        name: 'Sam',
        email: 'sam@example.test',
        password: 'sam-password-1234',
        invitation: invitation.token,
      }),
    };
    const key = store.createToken(editor, workspace.id, {
      name: 'Research agent',
      scope: 'write',
    });
    const agent = store.tokenActor(key.token)!;
    const second = store.updateArtifact(owner, {
      artifactId: artifact.id,
      expectedRevisionId: artifact.currentRevisionId,
      body: '# Revised\n\nNew scope.',
    });
    for (const actor of [editor, agent])
      assert.throws(
        () =>
          store.updateArtifact(actor, {
            artifactId: artifact.id,
            expectedRevisionId: artifact.currentRevisionId,
            body: 'stale write',
          }),
        fails('revision_conflict'),
      );
    const third = store.updateArtifact(agent, {
      artifactId: artifact.id,
      expectedRevisionId: second.currentRevisionId,
      body: '# Agent contribution',
    });
    assert.equal(third.revision.agentName, 'Research agent');
    assert.equal(third.revision.authorName, 'Sam');
    assert.throws(
      () =>
        store.restore(owner, {
          artifactId: artifact.id,
          expectedRevisionId: second.currentRevisionId,
          revisionId: artifact.currentRevisionId,
        }),
      fails('revision_conflict'),
    );
    const restored = store.restore(editor, {
      artifactId: artifact.id,
      expectedRevisionId: third.currentRevisionId,
      revisionId: artifact.currentRevisionId,
    });
    assert.equal(restored.revision.number, 4);
    assert.equal(restored.revision.body, artifact.revision.body);
    assert.equal(restored.revision.restoredFrom, artifact.currentRevisionId);
    assert.equal(
      store.revision(owner, artifact.id, second.currentRevisionId).body,
      second.revision.body,
    );
    assert.equal(store.revisions(owner, artifact.id).length, 4);
  } finally {
    store.close();
  }
});

test('viewer access, scoped keys, cross-workspace IDs, revocation, and removal are enforced', async () => {
  const { store, owner, workspace, artifact } = await fixture();
  try {
    const invitation = store.invite(owner, workspace.id, { role: 'viewer' });
    const viewer = {
      user: await store.register({
        name: 'Viewer',
        email: 'viewer@example.test',
        password: 'viewer-password-1234',
        invitation: invitation.token,
      }),
    };
    assert.equal(store.artifact(viewer, artifact.id).id, artifact.id);
    assert.throws(
      () =>
        store.addComment(viewer, {
          artifactId: artifact.id,
          revisionId: artifact.currentRevisionId,
          body: 'No',
        }),
      fails('read_only'),
    );
    assert.throws(
      () =>
        store.updateArtifact(viewer, {
          artifactId: artifact.id,
          expectedRevisionId: artifact.currentRevisionId,
          body: 'No',
        }),
      fails('read_only'),
    );
    assert.throws(
      () =>
        store.createToken(viewer, workspace.id, {
          name: 'Agent',
          scope: 'write',
        }),
      fails('read_only'),
    );
    const other = store.createWorkspace(owner, { name: 'Private' });
    const otherDoc = store.createArtifact(owner, {
      workspaceId: other.id,
      path: 'secret.md',
      body: 'Secret',
    });
    const key = store.createToken(owner, workspace.id, {
      name: 'Read agent',
      scope: 'read',
    });
    const agent = store.tokenActor(key.token)!;
    assert.equal(store.workspaces(agent).length, 1);
    assert.throws(() => store.artifact(agent, otherDoc.id), fails('not_found'));
    assert.throws(
      () =>
        store.createArtifact(agent, {
          workspaceId: workspace.id,
          path: 'new.md',
          body: '',
        }),
      fails('read_only'),
    );
    assert.throws(
      () => store.invite(agent, workspace.id, { role: 'editor' }),
      fails('read_only'),
    );
    store.revokeToken(owner, workspace.id, key.id);
    assert.equal(store.tokenActor(key.token), undefined);
    const viewerKey = store.createToken(viewer, workspace.id, {
      name: 'Viewer agent',
      scope: 'read',
    });
    store.removeMember(owner, workspace.id, viewer.user.id);
    assert.equal(store.tokenActor(viewerKey.token), undefined);
    assert.throws(
      () => store.artifact(viewer, artifact.id),
      fails('not_found'),
    );
  } finally {
    store.close();
  }
});

test('comments keep their revision and quote through edits, replies and resolution', async () => {
  const { store, owner, artifact } = await fixture();
  try {
    const comment = store.addComment(owner, {
      artifactId: artifact.id,
      revisionId: artifact.currentRevisionId,
      body: 'Clarify this.',
      quote: 'shared place',
      anchor: { blockId: 'block-0', startOffset: 0, endOffset: 10 },
    });
    store.updateArtifact(owner, {
      artifactId: artifact.id,
      expectedRevisionId: artifact.currentRevisionId,
      body: '# Completely changed',
    });
    store.reply(owner, { commentId: comment.id, body: 'Updated the plan.' });
    store.resolve(owner, { commentId: comment.id, resolved: true });
    assert.throws(
      () => store.reply(owner, { commentId: comment.id, body: 'Late' }),
      fails('thread_resolved'),
    );
    store.resolve(owner, { commentId: comment.id, resolved: false });
    const saved = store.comments(owner, artifact.id)[0];
    assert.equal(saved.quote, 'shared place');
    assert.equal(saved.revisionId, artifact.currentRevisionId);
    assert.equal(saved.replies[0].body, 'Updated the plan.');
    assert.equal(saved.resolved, false);
  } finally {
    store.close();
  }
});

test('restart retains artifacts, revisions, comments, identities and revocations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-store-'));
  let store = new Store(join(directory, 'db.sqlite'));
  try {
    const owner = { user: await store.setup(ownerInput) };
    const workspace = store.workspaces(owner)[0],
      doc = store.createArtifact(owner, {
        workspaceId: workspace.id,
        path: 'plans/nested/launch.md',
        body: '# Legacy plan',
      });
    const updated = store.updateArtifact(owner, {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '# Durable\n\nContent',
    });
    store.addComment(owner, {
      artifactId: doc.id,
      revisionId: updated.currentRevisionId,
      body: 'Still here.',
    });
    store.review(owner, {
      artifactId: doc.id,
      expectedRevisionId: updated.currentRevisionId,
      decision: 'approved',
      note: 'Persist this decision.',
    });
    const session = store.session(owner.user);
    const token = store.createToken(owner, workspace.id, {
      name: 'Revoked',
      scope: 'read',
    });
    store.revokeToken(owner, workspace.id, token.id);
    legacyNames(store.db);
    // Recreate the v1 layout, as used by existing installations.
    store.db.exec(`ALTER TABLE comments DROP COLUMN kind;
      ALTER TABLE comments DROP COLUMN label_tip;
      ALTER TABLE comments DROP COLUMN images;
      ALTER TABLE comments DROP COLUMN version;
      ALTER TABLE comments DROP COLUMN updated_at;
      ALTER TABLE comments DROP COLUMN author_token_id;
      ALTER TABLE comments DROP COLUMN diff;
      DROP TABLE comment_submissions;
      PRAGMA user_version=1;`);
    store.db
      .exec(`DROP TABLE revision_links; DROP TABLE document_paths; DROP TABLE notifications; DROP TABLE service_accounts;
      DROP TRIGGER document_search_update; DROP TRIGGER document_search_delete; DROP TABLE document_search;
      ALTER TABLE documents DROP COLUMN archived_at; ALTER TABLE documents DROP COLUMN metadata_version;
      ALTER TABLE tokens DROP COLUMN last_used_at;
      DROP TABLE identities; DROP TABLE identity_flows;
      ALTER TABLE sessions DROP COLUMN auth_method;
      ALTER TABLE users DROP COLUMN recovery_until;
      DROP VIEW effective_members;
      DROP TABLE team_workspaces; DROP TABLE team_members; DROP TABLE teams;
      DROP TABLE organization; DROP TABLE audit_log;
      ALTER TABLE users DROP COLUMN org_role;
      ALTER TABLE users DROP COLUMN disabled_at;
      ALTER TABLE invites DROP COLUMN created_by;`);
    store.close();
    store = new Store(join(directory, 'db.sqlite'));
    assert.equal(store.catalog(owner, workspace.id).folders.length, 2);
    assert.ok(store.artifact(owner, doc.id).folderId);
    assert.equal(store.sessionActor(session)?.user.id, owner.user.id);
    assert.equal(store.search(owner, { query: 'Durable' })[0].id, doc.id);
    assert.equal(store.organization(owner).isAdmin, true);
    assert.equal(
      store.organizationAdmin(owner).workspaces[0].members[0].role,
      'owner',
    );
    assert.equal(
      store.artifact(owner, doc.id).revision.body,
      '# Durable\n\nContent',
    );
    assert.equal(
      store.artifact(owner, doc.id).reviews[0].note,
      'Persist this decision.',
    );
    assert.equal(store.comments(owner, doc.id)[0].body, 'Still here.');
    assert.equal(store.comments(owner, doc.id)[0].kind, 'comment');
    assert.deepEqual(store.comments(owner, doc.id)[0].images, []);
    const deletion = store.addComment(owner, {
      artifactId: doc.id,
      revisionId: updated.currentRevisionId,
      kind: 'deletion',
      quote: 'Content',
    });
    const label = store.addComment(owner, {
      artifactId: doc.id,
      revisionId: updated.currentRevisionId,
      kind: 'label',
      quote: 'Durable',
      body: 'Verify this',
      labelTip: 'Check the actual implementation.',
    });
    store.close();
    store = new Store(join(directory, 'db.sqlite'));
    assert.equal(
      store.comments(owner, doc.id).find((c) => c.id === deletion.id)?.kind,
      'deletion',
    );
    assert.equal(
      store.comments(owner, doc.id).find((c) => c.id === label.id)?.labelTip,
      'Check the actual implementation.',
    );
    assert.equal(store.revisions(owner, doc.id).length, 2);
    assert.equal(store.tokenActor(token.token), undefined);
    assert.equal((await store.login(ownerInput)).id, owner.user.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invitations are single-use, revocable and expire; bootstrap can only happen once', async () => {
  const { store, owner, workspace } = await fixture();
  try {
    await assert.rejects(
      store.setup({ ...ownerInput, email: 'another@example.test' }),
      fails('already_configured'),
    );
    const revoked = store.invite(owner, workspace.id, { role: 'editor' });
    store.revokeInvite(owner, workspace.id, revoked.id);
    assert.throws(
      () => store.inspectInvite(revoked.token),
      fails('invite_unavailable'),
    );
    const expired = store.invite(owner, workspace.id, { role: 'editor' });
    store.run(
      'UPDATE invites SET expires_at=? WHERE id=?',
      '2000-01-01',
      expired.id,
    );
    assert.throws(
      () => store.inspectInvite(expired.token),
      fails('invite_unavailable'),
    );
    const used = store.invite(owner, workspace.id, { role: 'editor' });
    await store.register({
      name: 'Sam',
      email: 'sam@example.test',
      password: 'sam-password-1234',
      invitation: used.token,
    });
    assert.throws(
      () => store.inspectInvite(used.token),
      fails('invite_unavailable'),
    );
    assert.equal(store.members(owner, workspace.id).length, 2);
  } finally {
    store.close();
  }
});

test('invalid paths and cross-artifact revision references never create partial state', async () => {
  const { store, owner, workspace, artifact } = await fixture();
  try {
    for (const path of [
      '../plan.md',
      '/plan.md',
      'a//b.md',
      'a/../b.md',
      'plan.html',
    ])
      assert.throws(() =>
        store.createArtifact(owner, {
          workspaceId: workspace.id,
          path,
          body: 'bad',
        }),
      );
    assert.throws(
      () =>
        store.createArtifact(owner, {
          workspaceId: workspace.id,
          path: artifact.path,
          body: 'duplicate',
        }),
      fails('path_exists'),
    );
    const other = store.createArtifact(owner, {
      workspaceId: workspace.id,
      path: 'other.md',
      body: 'other',
    });
    assert.throws(
      () =>
        store.restore(owner, {
          artifactId: artifact.id,
          expectedRevisionId: artifact.currentRevisionId,
          revisionId: other.currentRevisionId,
        }),
      fails('not_found'),
    );
    assert.throws(
      () =>
        store.addComment(owner, {
          artifactId: artifact.id,
          revisionId: other.currentRevisionId,
          body: 'mismatched',
        }),
      fails('not_found'),
    );
    assert.equal(store.revisions(owner, artifact.id).length, 1);
    assert.equal(store.artifacts(owner, workspace.id).length, 2);
  } finally {
    store.close();
  }
});

test('relative artifact links keep identity through moves, edits, restore and database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-links-'));
  const path = join(directory, 'workspace.sqlite');
  let store = new Store(path);
  try {
    const actor = { user: await store.setup(ownerInput) };
    const workspace = store.workspaces(actor)[0];
    const source = store.createArtifact(actor, {
      workspaceId: workspace.id,
      path: 'plans/source.md',
      body: '# Source\n\n[Target](target.md#details)',
    });
    const target = store.createArtifact(actor, {
      workspaceId: workspace.id,
      path: 'plans/target.md',
      body: '# Target',
    });
    for (const [artifact, next] of [
      [source, 'moved/source.md'],
      [target, 'moved/target.md'],
    ] as const)
      store.changeArtifact(actor, {
        artifactId: artifact.id,
        expectedRevisionId: artifact.currentRevisionId,
        expectedMetadataVersion: artifact.metadataVersion,
        path: next,
      });
    const updated = store.updateArtifact(actor, {
      artifactId: source.id,
      expectedRevisionId: source.currentRevisionId,
      body: source.revision.body + '\n\nA new paragraph.',
    });
    const restored = store.restore(actor, {
      artifactId: source.id,
      expectedRevisionId: updated.currentRevisionId,
      revisionId: source.currentRevisionId,
    });
    store.close();
    store = new Store(path);
    for (const revision of [source, updated, restored]) {
      const resolved = store.resolveLink(actor, source.id, {
        revisionId: revision.currentRevisionId,
        href: 'target.md#details',
      });
      assert.equal(resolved.artifactId, target.id);
      assert.equal(resolved.fragment, 'details');
    }
    assert.throws(
      () =>
        store.createArtifact(actor, {
          workspaceId: workspace.id,
          path: 'plans/target.md',
          body: '# Impostor',
        }),
      fails('path_exists'),
    );
    assert.throws(() =>
      store.resolveLink(actor, source.id, {
        revisionId: target.currentRevisionId,
        href: 'target.md',
      }),
    );
    assert.throws(
      () =>
        store.resolveLink(actor, source.id, {
          revisionId: source.currentRevisionId,
          href: 'https://example.test/target.md',
        }),
      fails('invalid_link'),
    );
    const elsewhere = store.createWorkspace(actor, { name: 'Elsewhere' });
    const token = store.createToken(actor, elsewhere.id, {
      name: 'Scoped reader',
      scope: 'read',
    });
    assert.throws(() =>
      store.resolveLink(store.tokenActor(token.token)!, source.id, {
        revisionId: source.currentRevisionId,
        href: 'target.md#details',
      }),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema 11 upgrade preserves nested paths, archived artifacts and lost-save receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-artifact-upgrade-'));
  const filename = join(directory, 'db.sqlite');
  let store = new Store(filename);
  try {
    const owner = { user: await store.setup(ownerInput) };
    const workspace = store.workspaces(owner)[0];
    const artifact = store.createArtifact(owner, {
      workspaceId: workspace.id,
      path: 'plans/nested/proposal.md',
      body: '# Durable artifact',
    });
    const input = {
      artifactId: artifact.id,
      revisionId: artifact.currentRevisionId,
      body: 'Preserve this unsent acknowledgment.',
      submissionId: crypto.randomUUID(),
    };
    const comment = store.addComment(owner, input);
    // Schema 11 used the legacy property name in receipt fingerprints.
    const { addComment } = await import('../server/schemas.ts');
    const { digest } = await import('../server/security.ts');
    const { legacyFields } = await import('../server/compatibility.ts');
    store.run(
      'UPDATE comment_submissions SET fingerprint=? WHERE submission_id=?',
      digest(JSON.stringify(legacyFields(addComment.parse(input), true))),
      input.submissionId,
    );
    const archived = store.createArtifact(owner, {
      workspaceId: workspace.id,
      path: 'plans/nested/archive.md',
      body: '# Past decision',
    });
    store.changeArtifact(owner, {
      artifactId: archived.id,
      expectedRevisionId: archived.currentRevisionId,
      expectedMetadataVersion: archived.metadataVersion,
      archived: true,
    });
    legacyNames(store.db);
    store.close();
    store = new Store(filename);
    const catalog = store.catalog(owner, workspace.id);
    assert.deepEqual(catalog.folders.map((f) => f.name).sort(), [
      'nested',
      'plans',
    ]);
    assert.ok(store.artifact(owner, archived.id).archivedAt);
    assert.equal(store.addComment(owner, input).id, comment.id);
    assert.equal(store.comments(owner, artifact.id).length, 1);
    assert.equal(store.search(owner, { query: 'Durable' })[0].id, artifact.id);
    assert.deepEqual(store.all('PRAGMA foreign_key_check'), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
