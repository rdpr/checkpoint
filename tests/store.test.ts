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
  const document = store.document(
    owner,
    store.documents(owner, workspace.id)[0].id,
  );
  return { store, owner, workspace, document };
}

test('two editors and an agent cannot overwrite a newer revision; restore preserves history', async () => {
  const { store, owner, workspace, document } = await fixture();
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
    const second = store.updateDocument(owner, {
      documentId: document.id,
      expectedRevisionId: document.currentRevisionId,
      body: '# Revised\n\nNew scope.',
    });
    for (const actor of [editor, agent])
      assert.throws(
        () =>
          store.updateDocument(actor, {
            documentId: document.id,
            expectedRevisionId: document.currentRevisionId,
            body: 'stale write',
          }),
        fails('revision_conflict'),
      );
    const third = store.updateDocument(agent, {
      documentId: document.id,
      expectedRevisionId: second.currentRevisionId,
      body: '# Agent contribution',
    });
    assert.equal(third.revision.agentName, 'Research agent');
    assert.equal(third.revision.authorName, 'Sam');
    assert.throws(
      () =>
        store.restore(owner, {
          documentId: document.id,
          expectedRevisionId: second.currentRevisionId,
          revisionId: document.currentRevisionId,
        }),
      fails('revision_conflict'),
    );
    const restored = store.restore(editor, {
      documentId: document.id,
      expectedRevisionId: third.currentRevisionId,
      revisionId: document.currentRevisionId,
    });
    assert.equal(restored.revision.number, 4);
    assert.equal(restored.revision.body, document.revision.body);
    assert.equal(restored.revision.restoredFrom, document.currentRevisionId);
    assert.equal(
      store.revision(owner, document.id, second.currentRevisionId).body,
      second.revision.body,
    );
    assert.equal(store.revisions(owner, document.id).length, 4);
  } finally {
    store.close();
  }
});

test('viewer access, scoped keys, cross-workspace IDs, revocation, and removal are enforced', async () => {
  const { store, owner, workspace, document } = await fixture();
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
    assert.equal(store.document(viewer, document.id).id, document.id);
    assert.throws(
      () =>
        store.addComment(viewer, {
          documentId: document.id,
          revisionId: document.currentRevisionId,
          body: 'No',
        }),
      fails('read_only'),
    );
    assert.throws(
      () =>
        store.updateDocument(viewer, {
          documentId: document.id,
          expectedRevisionId: document.currentRevisionId,
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
    const otherDoc = store.createDocument(owner, {
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
    assert.throws(() => store.document(agent, otherDoc.id), fails('not_found'));
    assert.throws(
      () =>
        store.createDocument(agent, {
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
      () => store.document(viewer, document.id),
      fails('not_found'),
    );
  } finally {
    store.close();
  }
});

test('comments keep their revision and quote through edits, replies and resolution', async () => {
  const { store, owner, document } = await fixture();
  try {
    const comment = store.addComment(owner, {
      documentId: document.id,
      revisionId: document.currentRevisionId,
      body: 'Clarify this.',
      quote: 'shared place',
      anchor: { blockId: 'block-0', startOffset: 0, endOffset: 10 },
    });
    store.updateDocument(owner, {
      documentId: document.id,
      expectedRevisionId: document.currentRevisionId,
      body: '# Completely changed',
    });
    store.reply(owner, { commentId: comment.id, body: 'Updated the plan.' });
    store.resolve(owner, { commentId: comment.id, resolved: true });
    assert.throws(
      () => store.reply(owner, { commentId: comment.id, body: 'Late' }),
      fails('thread_resolved'),
    );
    store.resolve(owner, { commentId: comment.id, resolved: false });
    const saved = store.comments(owner, document.id)[0];
    assert.equal(saved.quote, 'shared place');
    assert.equal(saved.revisionId, document.currentRevisionId);
    assert.equal(saved.replies[0].body, 'Updated the plan.');
    assert.equal(saved.resolved, false);
  } finally {
    store.close();
  }
});

test('restart retains documents, revisions, comments, identities and revocations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-store-'));
  let store = new Store(join(directory, 'db.sqlite'));
  try {
    const owner = { user: await store.setup(ownerInput) };
    const workspace = store.workspaces(owner)[0],
      doc = store.documents(owner, workspace.id)[0];
    const updated = store.updateDocument(owner, {
      documentId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '# Durable\n\nContent',
    });
    store.addComment(owner, {
      documentId: doc.id,
      revisionId: updated.currentRevisionId,
      body: 'Still here.',
    });
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
    store.review(owner, {
      documentId: doc.id,
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
    assert.equal(store.sessionActor(session)?.user.id, owner.user.id);
    assert.equal(store.search(owner, { query: 'Durable' })[0].id, doc.id);
    assert.equal(store.organization(owner).isAdmin, true);
    assert.equal(
      store.organizationAdmin(owner).workspaces[0].members[0].role,
      'owner',
    );
    assert.equal(
      store.document(owner, doc.id).revision.body,
      '# Durable\n\nContent',
    );
    assert.equal(
      store.document(owner, doc.id).reviews[0].note,
      'Persist this decision.',
    );
    assert.equal(store.comments(owner, doc.id)[0].body, 'Still here.');
    assert.equal(store.comments(owner, doc.id)[0].kind, 'comment');
    assert.deepEqual(store.comments(owner, doc.id)[0].images, []);
    const deletion = store.addComment(owner, {
      documentId: doc.id,
      revisionId: updated.currentRevisionId,
      kind: 'deletion',
      quote: 'Content',
    });
    const label = store.addComment(owner, {
      documentId: doc.id,
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

test('invalid paths and cross-document revision references never create partial state', async () => {
  const { store, owner, workspace, document } = await fixture();
  try {
    for (const path of [
      '../plan.md',
      '/plan.md',
      'a//b.md',
      'a/../b.md',
      'plan.html',
    ])
      assert.throws(() =>
        store.createDocument(owner, {
          workspaceId: workspace.id,
          path,
          body: 'bad',
        }),
      );
    assert.throws(
      () =>
        store.createDocument(owner, {
          workspaceId: workspace.id,
          path: document.path,
          body: 'duplicate',
        }),
      fails('path_exists'),
    );
    const other = store.createDocument(owner, {
      workspaceId: workspace.id,
      path: 'other.md',
      body: 'other',
    });
    assert.throws(
      () =>
        store.restore(owner, {
          documentId: document.id,
          expectedRevisionId: document.currentRevisionId,
          revisionId: other.currentRevisionId,
        }),
      fails('not_found'),
    );
    assert.throws(
      () =>
        store.addComment(owner, {
          documentId: document.id,
          revisionId: other.currentRevisionId,
          body: 'mismatched',
        }),
      fails('not_found'),
    );
    assert.equal(store.revisions(owner, document.id).length, 1);
    assert.equal(store.documents(owner, workspace.id).length, 2);
  } finally {
    store.close();
  }
});

test('relative document links keep identity through moves, edits, restore and database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-links-'));
  const path = join(directory, 'workspace.sqlite');
  let store = new Store(path);
  try {
    const actor = { user: await store.setup(ownerInput) };
    const workspace = store.workspaces(actor)[0];
    const source = store.createDocument(actor, {
      workspaceId: workspace.id,
      path: 'plans/source.md',
      body: '# Source\n\n[Target](target.md#details)',
    });
    const target = store.createDocument(actor, {
      workspaceId: workspace.id,
      path: 'plans/target.md',
      body: '# Target',
    });
    for (const [document, next] of [
      [source, 'moved/source.md'],
      [target, 'moved/target.md'],
    ] as const)
      store.changeDocument(actor, {
        documentId: document.id,
        expectedRevisionId: document.currentRevisionId,
        expectedMetadataVersion: document.metadataVersion,
        path: next,
      });
    const updated = store.updateDocument(actor, {
      documentId: source.id,
      expectedRevisionId: source.currentRevisionId,
      body: source.revision.body + '\n\nA new paragraph.',
    });
    const restored = store.restore(actor, {
      documentId: source.id,
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
      assert.equal(resolved.documentId, target.id);
      assert.equal(resolved.fragment, 'details');
    }
    assert.throws(
      () =>
        store.createDocument(actor, {
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
