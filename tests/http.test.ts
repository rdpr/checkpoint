import { version } from '../shared/version.ts';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { Store } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function fixture(
  options: Partial<Parameters<typeof createApp>[1]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'pw-http-'));
  const filename = join(directory, 'db.sqlite');
  const store = new Store(filename);
  const owner = {
    user: await store.setup({
      name: 'Owner',
      email: 'owner@example.test',
      password: 'owner-password-1234',
    }),
  };
  const workspace = store.workspaces(owner)[0];
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on(
    'request',
    createApp(store, { origins: [base], serveStatic: false, ...options }),
  );
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { store, owner, workspace, base, request, close, filename };
}

test('trusted proxies isolate authentication clients and exclude logout and unknown routes', async () => {
  const f = await fixture({ trustedProxies: ['127.0.0.1/32'] });
  try {
    const attempt = (
      ip: string,
      path = '/api/auth/login',
      password = 'wrong-password',
      email = 'owner@example.test',
    ) =>
      f.request(path, {
        method: 'POST',
        headers: { 'X-Forwarded-For': ip },
        body: JSON.stringify({ email, password }),
      });
    for (let i = 0; i < 10; i++) {
      assert.equal(
        (
          await attempt(
            i % 2 ? '::ffff:203.0.113.5' : '203.0.113.5, 127.0.0.1',
            i % 2 ? '/API/AUTH/LOGIN/' : '/api/auth/login',
            'wrong-password',
            i % 2 ? ' OWNER@EXAMPLE.TEST ' : 'owner@example.test',
          )
        ).status,
        401,
      );
    }
    assert.equal((await attempt('203.0.113.5')).status, 429);
    assert.equal(
      (
        await attempt(
          '203.0.113.6',
          '/api/auth/login',
          'owner-password-1234',
        )
      ).status,
      200,
    );
    // Client-supplied entries left of the first untrusted hop cannot rotate the key.
    assert.equal((await attempt('198.51.100.1, 203.0.113.5')).status, 429);
    for (let i = 0; i < 25; i++) {
      assert.equal(
        (await attempt('203.0.113.7', '/api/auth/logout')).status,
        200,
      );
      assert.notEqual(
        (await attempt('203.0.113.7', '/api/auth/missing')).status,
        429,
      );
    }
    assert.equal(
      (
        await attempt(
          '203.0.113.7',
          '/api/auth/login',
          'owner-password-1234',
        )
      ).status,
      200,
    );
    // A separate per-client allowance still bounds attempts against many accounts.
    for (let i = 0; i < 20; i++)
      assert.equal(
        (
          await attempt(
            '203.0.113.8',
            '/api/auth/login',
            'wrong-password',
            `unknown${i}@example.test`,
          )
        ).status,
        401,
      );
    assert.equal(
      (
        await attempt(
          '203.0.113.8',
          '/api/auth/login',
          'owner-password-1234',
        )
      ).status,
      429,
    );
  } finally {
    await f.close();
  }
});

test('untrusted peers cannot rotate authentication quotas with forwarding headers', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 11; i++) {
      const response = await f.request('/api/auth/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` },
        body: JSON.stringify({
          email: 'owner@example.test',
          password: 'wrong-password',
        }),
      });
      assert.equal(response.status, i < 10 ? 401 : 429);
    }
  } finally {
    await f.close();
  }
});

test('expensive diff comments are bounded across HTTP aliases and MCP while other workspaces stay responsive', async () => {
  const f = await fixture();
  const client = new Client({ name: 'diff-budget-test', version: '1' });
  try {
    const key = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Diff agent',
      scope: 'write',
    });
    const headers = { Authorization: `Bearer ${key.token}` };
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: { headers },
      }),
    );
    const other = f.store.createWorkspace(f.owner, {
      name: 'Independent workspace',
    });
    const readKey = f.store.createToken(f.owner, other.id, {
      name: 'Independent reader',
      scope: 'read',
    });
    const fixtures = [
      ['a\n'.repeat(50000), 'b\n'.repeat(50000)],
      ['.!'.repeat(50000), '?:'.repeat(50000)],
    ];
    for (const [i, [oldText, newText]] of fixtures.entries()) {
      const initial = f.store.createArtifact(f.owner, {
        workspaceId: f.workspace.id,
        path: `budget-${i}.txt`,
        body: oldText,
      });
      const current = f.store.updateArtifact(f.owner, {
        artifactId: initial.id,
        expectedRevisionId: initial.currentRevisionId,
        body: newText,
      });
      const input = {
        artifactId: initial.id,
        revisionId: current.currentRevisionId,
        submissionId: crypto.randomUUID(),
        body: 'Review this change',
        diff: {
          baseRevisionId: initial.currentRevisionId,
          blockIndex: 0,
          side: 'modified',
        },
      };
      const started = performance.now();
      const pending = f.request(
        `/api/${i ? 'documents' : 'artifacts'}/${initial.id}/comments`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
        },
      );
      // Check the real request loop throughout the worker's lifetime.
      for (let j = 0; j < 3; j++) {
        const health = await f.request('/api/health', {
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(health.status, 200);
        const read = await f.request(
          `/api/workspaces/${other.id}/artifacts`,
          {
            headers: { Authorization: `Bearer ${readKey.token}` },
            signal: AbortSignal.timeout(1000),
          },
        );
        assert.equal(read.status, 200);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const response = await pending;
      assert.equal(response.status, 422);
      assert.equal((await response.json()).code, 'comparison_too_complex');
      assert.ok(performance.now() - started < 5000);
      const mcp = await client.callTool({
        name: 'create_comment',
        arguments: input,
      });
      assert.equal(mcp.isError, true);
      assert.match(JSON.stringify(mcp.content), /comparison_too_complex/);
      assert.equal(f.store.comments(f.owner, initial.id).length, 0);
      assert.equal(
        f.store.one(
          'SELECT submission_id FROM comment_submissions WHERE submission_id=?',
          input.submissionId,
        ),
        undefined,
      );
      const discussion = await f.request(
        `/api/artifacts/${initial.id}/comments`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...input, diff: null }),
        },
      );
      assert.equal(discussion.status, 201);
    }
  } finally {
    await client.close();
    await f.close();
  }
});

test('diff submissions remain atomic and recheck revoked credentials after asynchronous comparison', async () => {
  const f = await fixture();
  try {
    const initial = f.store.createArtifact(f.owner, {
      workspaceId: f.workspace.id,
      path: 'atomic.md',
      body: '# Before\n',
    });
    const current = f.store.updateArtifact(f.owner, {
      artifactId: initial.id,
      expectedRevisionId: initial.currentRevisionId,
      body: '# After\n',
    });
    const input = {
      artifactId: initial.id,
      revisionId: current.currentRevisionId,
      submissionId: crypto.randomUUID(),
      body: 'Keep the explanation',
      diff: {
        baseRevisionId: initial.currentRevisionId,
        blockIndex: 0,
        side: 'modified',
      },
    };
    const headers = {
      Cookie: `pw_session=${f.store.session(f.owner.user)}`,
    };
    const submit = () =>
      f.request(`/api/artifacts/${initial.id}/comments`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });
    const [a, b] = await Promise.all([submit(), submit()]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const first = await a.json();
    assert.equal((await b.json()).id, first.id);
    assert.equal(first.quote, '- # Before\n+ # After');
    assert.equal(f.store.comments(f.owner, initial.id).length, 1);
    const key = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Revoked during comparison',
      scope: 'write',
    });
    const pending = f.store.addComment(f.store.tokenActor(key.token)!, {
      ...input,
      submissionId: crypto.randomUUID(),
    });
    f.store.revokeToken(f.owner, f.workspace.id, key.id);
    await assert.rejects(pending, { code: 'unauthorized' });
    assert.equal(f.store.comments(f.owner, initial.id).length, 1);
    const session = f.store.session(f.owner.user);
    const browserPending = f.store.addComment(
      f.store.sessionActor(session)!,
      { ...input, submissionId: crypto.randomUUID() },
    );
    f.store.logout(session);
    assert.equal(f.store.sessionActor(session), undefined);
    await assert.rejects(browserPending, { code: 'unauthorized' });
    assert.equal(f.store.comments(f.owner, initial.id).length, 1);
  } finally {
    await f.close();
  }
});

test('HTTP sessions, CSRF/host checks, permissions and logout', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/workspaces')).status, 401);
    const login = await f.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'owner-password-1234',
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const headers = { Cookie: cookie.split(';')[0] };
    assert.equal((await f.request('/api/workspaces', { headers })).status, 200);
    assert.equal(
      (
        await f.request('/api/workspaces', {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.test' },
          body: '{"name":"bad"}',
        })
      ).status,
      403,
    );
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        f.base + '/api/workspaces',
        { headers: { Host: 'evil.test', ...headers } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHost, 403);
    const noOrigin = await fetch(f.base + '/api/workspaces', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{"name":"bad"}',
    });
    assert.equal(noOrigin.status, 403);
    const doc = f.store.artifacts(f.owner, f.workspace.id)[0];
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=',
      'base64',
    );
    const upload = await f.request(`/api/artifacts/${doc.id}/images`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    assert.equal(upload.status, 201);
    const image = await upload.json();
    const downloaded = await f.request(image.path, { headers });
    assert.equal(downloaded.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    const comment = await f.request(`/api/artifacts/${doc.id}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        revisionId: doc.currentRevisionId,
        images: [{ path: image.path, name: 'Screenshot' }],
      }),
    });
    assert.equal(comment.status, 201);
    assert.equal((await comment.json()).images[0].path, image.path);
    const other = f.store.createWorkspace(f.owner, { name: 'Other' });
    const otherDoc = f.store.createArtifact(f.owner, {
      workspaceId: other.id,
      path: 'plan.md',
      body: '# Private',
    });
    const wrongArtifact = await f.request(
      `/api/artifacts/${otherDoc.id}/comments`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          revisionId: otherDoc.currentRevisionId,
          body: 'Cross-artifact reference',
          images: [{ path: image.path, name: 'Private' }],
        }),
      },
    );
    assert.equal(wrongArtifact.status, 400);
    const scopedKey = f.store.createToken(f.owner, other.id, {
      name: 'Other workspace',
      scope: 'read',
    });
    assert.equal(
      (
        await f.request(image.path, {
          headers: { Authorization: `Bearer ${scopedKey.token}` },
        })
      ).status,
      404,
    );
    const invalid = await f.request(`/api/artifacts/${doc.id}/images`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: '<svg onload="alert(1)" />',
    });
    assert.equal(invalid.status, 400);
    await f.request('/api/auth/logout', {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal((await f.request('/api/workspaces', { headers })).status, 401);
    assert.equal((await f.request(image.path, { headers })).status, 401);
  } finally {
    await f.close();
  }
});

test('real MCP client reads, updates, comments, detects stale edits, and loses access on revocation', async () => {
  const f = await fixture();
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    const key = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Test agent',
      scope: 'write',
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(f.base + '/mcp'),
      { requestInit: { headers: { Authorization: `Bearer ${key.token}` } } },
    );
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'export_feedback'));
    assert.ok(!tools.tools.some((t) => t.name === 'submit_review'));
    const doc = f.store.artifacts(f.owner, f.workspace.id)[0];
    const read = await client.callTool({
      name: 'read_artifact',
      arguments: { artifactId: doc.id },
    });
    assert.equal(read.isError, undefined);
    const update = {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '# Via MCP',
    };
    assert.equal(
      (await client.callTool({ name: 'update_artifact', arguments: update }))
        .isError,
      undefined,
    );
    assert.equal(
      (await client.callTool({ name: 'update_artifact', arguments: update }))
        .isError,
      true,
    );
    const saved = f.store.artifact(f.owner, doc.id);
    assert.equal(saved.revision.agentName, 'Test agent');
    await client.callTool({
      name: 'create_comment',
      arguments: {
        artifactId: doc.id,
        revisionId: saved.currentRevisionId,
        body: 'Ready for your review.',
        quote: 'Via MCP',
      },
    });
    assert.equal(f.store.comments(f.owner, doc.id)[0].agentName, 'Test agent');
    const annotation = f.store.comments(f.owner, doc.id)[0];
    const edited = await client.callTool({
      name: 'edit_comment',
      arguments: {
        commentId: annotation.id,
        expectedVersion: annotation.version,
        body: 'Updated agent feedback',
      },
    });
    assert.equal(edited.isError, undefined);
    assert.equal(
      (
        await client.callTool({
          name: 'reattach_comment',
          arguments: {
            commentId: annotation.id,
            expectedVersion: 2,
            expectedRevisionId: saved.currentRevisionId,
            quote: 'Via MCP',
            anchor: { blockId: 'block-0', startOffset: 0, endOffset: 7 },
          },
        })
      ).isError,
      undefined,
    );
    const exported = await client.callTool({
      name: 'export_feedback',
      arguments: { artifactId: doc.id, revisionId: saved.currentRevisionId },
    });
    assert.match(JSON.stringify(exported), /Updated agent feedback/);
    assert.equal(
      (
        await client.callTool({
          name: 'list_reviews',
          arguments: { artifactId: doc.id },
        })
      ).isError,
      undefined,
    );
    const newest = f.store.comments(f.owner, doc.id)[0];
    assert.equal(
      (
        await client.callTool({
          name: 'delete_comment',
          arguments: {
            commentId: newest.id,
            expectedVersion: newest.version,
          },
        })
      ).isError,
      undefined,
    );
    f.store.revokeToken(f.owner, f.workspace.id, key.id);
    await assert.rejects(
      client.callTool({ name: 'list_workspaces', arguments: {} }),
    );
  } finally {
    await client.close();
    await f.close();
  }
});

test('HTTP review completion preserves identities, revision decisions, rich anchors and concurrent discussions across restart', async () => {
  const f = await fixture();
  try {
    const doc = f.store.artifacts(f.owner, f.workspace.id)[0];
    const member = async (role: 'editor' | 'viewer', name: string) => {
      const invite = f.store.invite(f.owner, f.workspace.id, { role });
      const user = await f.store.register({
        name,
        email: `${name}@example.test`,
        password: 'a-valid-password-123',
        invitation: invite.token,
      });
      return { user };
    };
    const editor = await member('editor', 'Editor');
    const viewer = await member('viewer', 'Viewer');
    // Use actual session cookie name from the login response.
    const login = await f.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'owner-password-1234',
      }),
    });
    const ownerHeaders = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0],
    };
    const sessionName = ownerHeaders.Cookie.split('=')[0];
    const editorHeaders = {
      Cookie: `${sessionName}=${f.store.session(editor.user)}`,
    };
    const viewerHeaders = {
      Cookie: `${sessionName}=${f.store.session(viewer.user)}`,
    };
    const agentKey = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Agent',
      scope: 'write',
    });
    const agentHeaders = { Authorization: `Bearer ${agentKey.token}` };
    const send = (
      path: string,
      headers: Record<string, string>,
      body: unknown,
      method = 'POST',
    ) => f.request(path, { method, headers, body: JSON.stringify(body) });
    const reviewUrl = `/api/artifacts/${doc.id}/reviews`;
    const decision = {
      expectedRevisionId: doc.currentRevisionId,
      decision: 'approved',
      note: 'Ready',
      reviewerName: 'Forged person',
    };
    assert.equal((await send(reviewUrl, viewerHeaders, decision)).status, 403);
    assert.equal((await send(reviewUrl, agentHeaders, decision)).status, 403);
    const approved = await send(reviewUrl, ownerHeaders, decision);
    assert.equal(approved.status, 201);
    assert.equal((await approved.json()).reviews[0].reviewerName, 'Owner');
    await send(reviewUrl, editorHeaders, {
      ...decision,
      decision: 'changes_requested',
      note: 'Please revise',
    });
    const exported = () =>
      f
        .request(
          `/api/artifacts/${doc.id}/revisions/${doc.currentRevisionId}/feedback`,
          { headers: ownerHeaders },
        )
        .then((r) => r.json());
    assert.match((await exported()).markdown, /Status: Changes requested/);
    await send(reviewUrl, editorHeaders, {
      ...decision,
      decision: 'withdrawn',
    });
    assert.match((await exported()).markdown, /Status: Approved/);
    const anchor = {
      blockId: 'block-2',
      mathTargets: [{ blockId: 'block-3', tex: 'x^2', displayMode: false }],
      diagramAnchor: {
        v: 1,
        family: 'flowchart',
        kind: 'node',
        id: 'A',
        label: 'Start',
        sourceLine: [4, 4],
        injected: 'strip me',
      },
      author: 'Forged',
      unsupportedAnchor: { selector: '*' },
    };
    const created = await send(
      `/api/artifacts/${doc.id}/comments`,
      ownerHeaders,
      {
        revisionId: doc.currentRevisionId,
        body: 'Check formula and diagram',
        quote: 'Start',
        anchor,
      },
    );
    assert.equal(created.status, 201);
    const comment = await created.json();
    assert.equal(comment.anchor.mathTargets[0].tex, 'x^2');
    assert.equal(comment.anchor.diagramAnchor.id, 'A');
    assert.equal(comment.anchor.diagramAnchor.injected, undefined);
    assert.equal(comment.anchor.author, undefined);
    assert.equal(comment.anchor.unsupportedAnchor, undefined);
    const edits = {
      expectedVersion: comment.version,
      body: 'Corrected feedback',
    };
    assert.equal(
      (await send(`/api/comments/${comment.id}`, editorHeaders, edits, 'PUT'))
        .status,
      403,
    );
    assert.equal(
      (await send(`/api/comments/${comment.id}`, agentHeaders, edits, 'PUT'))
        .status,
      403,
    );
    assert.equal(
      (await send(`/api/comments/${comment.id}`, ownerHeaders, edits, 'PUT'))
        .status,
      200,
    );
    assert.equal(
      (await send(`/api/comments/${comment.id}`, ownerHeaders, edits, 'PUT'))
        .status,
      409,
    );
    await send(`/api/comments/${comment.id}/replies`, editorHeaders, {
      body: 'Keep this reply',
    });
    assert.equal(
      (
        await send(
          `/api/comments/${comment.id}`,
          ownerHeaders,
          { expectedVersion: 2 },
          'DELETE',
        )
      ).status,
      409,
    );
    const feedback = (await exported()).markdown;
    assert.match(feedback, /Corrected feedback/);
    assert.match(feedback, /Keep this reply/);
    assert.match(feedback, /Diagram node Start/);
    const next = f.store.updateArtifact(f.owner, {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '# New revision',
    });
    assert.equal((await send(reviewUrl, ownerHeaders, decision)).status, 409);
    const current = await f
      .request(
        `/api/artifacts/${doc.id}/revisions/${next.currentRevisionId}/feedback`,
        { headers: ownerHeaders },
      )
      .then((r) => r.json());
    assert.match(current.markdown, /Status: Changes since approval/);
    const secondConnection = new Store(f.filename);
    try {
      assert.equal(
        secondConnection.artifact(f.owner, doc.id).reviews.length,
        3,
      );
      assert.deepEqual(
        secondConnection.comments(f.owner, doc.id)[0].anchor,
        f.store.comments(f.owner, doc.id)[0].anchor,
      );
    } finally {
      secondConnection.close();
    }
    const latest = f.store.comments(f.owner, doc.id)[0];
    assert.equal(
      (
        await send(
          `/api/comments/${comment.id}`,
          viewerHeaders,
          { expectedVersion: latest.version },
          'DELETE',
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await send(
          `/api/comments/${comment.id}`,
          editorHeaders,
          { expectedVersion: latest.version },
          'DELETE',
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await send(
          `/api/comments/${comment.id}`,
          ownerHeaders,
          { expectedVersion: latest.version },
          'DELETE',
        )
      ).status,
      200,
    );
    assert.equal(f.store.comments(f.owner, doc.id).length, 0);
    const foreign = f.store.createWorkspace(f.owner, { name: 'Private' });
    const privateDoc = f.store.createArtifact(f.owner, {
      workspaceId: foreign.id,
      path: 'private.md',
      body: '# Private',
    });
    assert.equal(
      (
        await f.request(
          `/api/artifacts/${privateDoc.id}/revisions/${privateDoc.currentRevisionId}/feedback`,
          { headers: editorHeaders },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await send(`/api/artifacts/${privateDoc.id}/reviews`, editorHeaders, {
          ...decision,
          expectedRevisionId: privateDoc.currentRevisionId,
        })
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test('revision comparisons and reattachment preserve provenance across HTTP, MCP and restart', async () => {
  const f = await fixture();
  const client = new Client({ name: 'revision-test', version: '1' });
  try {
    const login = await f.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'owner-password-1234',
      }),
    });
    const headers = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0],
    };
    const send = (
      path: string,
      body: unknown,
      method = 'POST',
      customHeaders = headers,
    ) =>
      f.request(path, {
        method,
        headers: customHeaders,
        body: JSON.stringify(body),
      });
    const initial = f.store.createArtifact(f.owner, {
      workspaceId: f.workspace.id,
      path: 'revision-review.md',
      body: '# Plan\n\nRemove this legacy task.\n\nKeep the stable task.\n',
    });
    const next = f.store.updateArtifact(f.owner, {
      artifactId: initial.id,
      expectedRevisionId: initial.currentRevisionId,
      body: '# Plan\n\nKeep the stable task.\n',
    });
    const { computePlanDiff } = await import(
      '@plannotator/ui/utils/planDiffEngine'
    );
    const blocks = computePlanDiff(
      initial.revision.body,
      next.revision.body,
    ).blocks;
    const diff = {
      baseRevisionId: initial.currentRevisionId,
      blockIndex: blocks.findIndex((b) => b.type === 'removed'),
      side: 'removed',
    };
    assert.ok(diff.blockIndex >= 0);
    const created = await send(`/api/artifacts/${initial.id}/comments`, {
      revisionId: next.currentRevisionId,
      body: 'Please retain the context',
      quote: 'Forged quote',
      diff,
      anchor: { blockId: 'forged', author: 'forged' },
    });
    assert.equal(created.status, 201);
    const comment = await created.json();
    assert.match(comment.quote, /Remove this legacy task/);
    assert.equal(comment.anchor.blockId, `diff-block-${diff.blockIndex}`);
    assert.deepEqual(comment.diff, diff);
    const invalid = {
      revisionId: next.currentRevisionId,
      body: 'invalid',
      diff: { ...diff, blockIndex: 99999 },
    };
    assert.equal(
      (await send(`/api/artifacts/${initial.id}/comments`, invalid)).status,
      400,
    );
    const privateDoc = f.store.createArtifact(f.owner, {
      workspaceId: f.workspace.id,
      path: 'other.md',
      body: '# Other',
    });
    assert.equal(
      (
        await send(`/api/artifacts/${initial.id}/comments`, {
          ...invalid,
          diff: { ...diff, baseRevisionId: privateDoc.currentRevisionId },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await send(`/api/artifacts/${initial.id}/comments`, {
          ...invalid,
          diff: { ...diff, baseRevisionId: next.currentRevisionId },
        })
      ).status,
      400,
    );
    const reattach = {
      expectedVersion: comment.version,
      expectedRevisionId: next.currentRevisionId,
      quote: 'Keep the stable task.',
      anchor: {
        blockId: 'block-1',
        startOffset: 0,
        endOffset: 21,
        author: 'forged',
      },
      authorName: 'Forged',
    };
    const invite = f.store.invite(f.owner, f.workspace.id, {
      role: 'viewer',
    });
    const viewer = await f.store.register({
      name: 'Viewer',
      email: 'viewer-revision@example.test',
      password: 'viewer-password-123',
      invitation: invite.token,
    });
    assert.equal(
      (
        await send(`/api/comments/${comment.id}/reattach`, reattach, 'POST', {
          Cookie: `pw_session=${f.store.session(viewer)}`,
        })
      ).status,
      403,
    );
    const agentKey = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Agent',
      scope: 'write',
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: {
          headers: { Authorization: `Bearer ${agentKey.token}` },
        },
      }),
    );
    assert.equal(
      (
        await client.callTool({
          name: 'reattach_comment',
          arguments: { commentId: comment.id, ...reattach },
        })
      ).isError,
      true,
    );
    const attached = await send(
      `/api/comments/${comment.id}/reattach`,
      reattach,
    );
    assert.equal(attached.status, 200);
    const saved = await attached.json();
    assert.equal(saved.revisionId, next.currentRevisionId);
    assert.equal(saved.quote, comment.quote);
    assert.deepEqual(saved.diff, comment.diff);
    assert.equal(saved.reattachments[0].authorName, 'Owner');
    assert.equal(saved.reattachments[0].anchor.author, undefined);
    assert.equal(
      (await send(`/api/comments/${comment.id}/reattach`, reattach)).status,
      409,
    );
    await send(`/api/comments/${comment.id}/replies`, {
      body: 'Keep this reply',
    });
    assert.equal(
      (
        await send(`/api/comments/${comment.id}/reattach`, {
          ...reattach,
          expectedVersion: saved.version,
        })
      ).status,
      409,
    );
    const third = f.store.updateArtifact(f.owner, {
      artifactId: initial.id,
      expectedRevisionId: next.currentRevisionId,
      body: '# Plan\n\nChanged again.',
    });
    assert.equal(
      (
        await send(`/api/comments/${comment.id}/reattach`, {
          ...reattach,
          expectedVersion: saved.version + 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await send(`/api/artifacts/${initial.id}/reviews`, {
          expectedRevisionId: next.currentRevisionId,
          decision: 'approved',
        })
      ).status,
      409,
    );
    const relocated = await send(`/api/comments/${comment.id}/reattach`, {
      ...reattach,
      expectedVersion: saved.version + 1,
      expectedRevisionId: third.currentRevisionId,
      quote: 'Changed again.',
    });
    assert.equal(relocated.status, 200);
    const olderExport = await client.callTool({
      name: 'export_feedback',
      arguments: {
        artifactId: initial.id,
        revisionId: next.currentRevisionId,
      },
    });
    assert.doesNotMatch(
      JSON.stringify(olderExport),
      /Reattached to revision 3/,
    );
    // An open comparison may still receive feedback on its exact older target.
    const oldFeedback = await send(`/api/artifacts/${initial.id}/comments`, {
      revisionId: next.currentRevisionId,
      body: 'Still on revision two',
      diff,
    });
    assert.equal(oldFeedback.status, 201);
    assert.equal((await oldFeedback.json()).revisionId, next.currentRevisionId);
    const exported = await client.callTool({
      name: 'export_feedback',
      arguments: {
        artifactId: initial.id,
        revisionId: third.currentRevisionId,
      },
    });
    assert.match(JSON.stringify(exported), /Comparison: revision 1 → 2/);
    assert.match(JSON.stringify(exported), /Reattached to revision 2/);
    assert.match(JSON.stringify(exported), /Keep this reply/);
    const reopened = new Store(f.filename);
    try {
      const persisted = reopened
        .comments(f.owner, initial.id)
        .find((c) => c.id === comment.id)!;
      assert.equal(persisted.reattachments.length, 2);
      assert.equal(persisted.replies[0].body, 'Keep this reply');
      assert.equal(persisted.quote, comment.quote);
    } finally {
      reopened.close();
    }
    const latest = f.store
      .comments(f.owner, initial.id)
      .find((c) => c.id === comment.id)!;
    assert.equal(
      (
        await send(
          `/api/comments/${comment.id}`,
          { expectedVersion: latest.version },
          'DELETE',
        )
      ).status,
      200,
    );
    assert.equal(
      f.store.one<{ count: number }>(
        'SELECT count(*) count FROM comment_reattachments',
      )!.count,
      0,
    );
  } finally {
    await client.close();
    await f.close();
  }
});

test('review requests cross HTTP and MCP with revision-bound rounds, attribution and capability checks', async () => {
  const f = await fixture();
  const client = new Client({ name: 'review-handoff', version: '1' });
  try {
    const member = async (role: 'editor' | 'viewer', name: string) => {
      const invitation = f.store.invite(f.owner, f.workspace.id, { role });
      return {
        user: await f.store.register({
          name,
          email: `${name}@requests.test`,
          password: 'a-valid-password-123',
          invitation: invitation.token,
        }),
      };
    };
    const editor = await member('editor', 'Reviewer');
    const viewer = await member('viewer', 'Reader');
    const headers = (user = f.owner.user) => ({
      Cookie: `pw_session=${f.store.session(user)}`,
    });
    const ownerHeaders = headers();
    const editorHeaders = headers(editor.user);
    const viewerHeaders = headers(viewer.user);
    const send = (path: string, body: unknown, auth = ownerHeaders) =>
      f.request(path, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body),
      });
    const key = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Implementer',
      scope: 'write',
    });
    const secondKey = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Implementer',
      scope: 'write',
    });
    const readKey = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Observer',
      scope: 'read',
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    };
    const reviewers = await call('list_reviewers', {
      workspaceId: f.workspace.id,
    });
    assert.ok(reviewers.some((r: any) => r.id === editor.user.id));
    assert.ok(!reviewers.some((r: any) => r.id === viewer.user.id));
    assert.ok(reviewers.every((r: any) => !('email' in r)));
    const doc = f.store.createArtifact(f.owner, {
      workspaceId: f.workspace.id,
      path: 'handoff.md',
      body: '# First draft',
    });
    const input = {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      reviewerId: editor.user.id,
      message: 'Please check the rollout.',
      requesterName: 'Forged',
    };
    const path = `/api/artifacts/${doc.id}/review-requests`;
    assert.equal((await send(path, input, viewerHeaders)).status, 403);
    assert.equal(
      (await send(path, { ...input, reviewerId: viewer.user.id })).status,
      400,
    );
    assert.equal(
      (
        await f.request(path, {
          method: 'POST',
          headers: { Authorization: `Bearer ${readKey.token}` },
          body: JSON.stringify(input),
        })
      ).status,
      403,
    );
    const request = await call('request_review', input);
    assert.equal(request.status, 'waiting');
    assert.equal(request.baseRevisionId, null);
    assert.equal(request.requesterName, 'Owner');
    assert.equal(request.agentName, 'Implementer');
    assert.ok(!('requesterTokenId' in request));
    assert.equal((await send(path, input)).status, 409);
    assert.equal(
      (
        await f.request(`/api/review-requests/${request.id}/cancel`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secondKey.token}` },
          body: JSON.stringify({ expectedVersion: request.version }),
        })
      ).status,
      403,
    );
    const inspect = () => f.store.reviewRequest(f.owner, request.id);
    await send(`/api/artifacts/${doc.id}/reviews`, {
      expectedRevisionId: doc.currentRevisionId,
      decision: 'approved',
    });
    assert.equal(
      inspect().status,
      'waiting',
      'another reviewer cannot complete the assigned review',
    );
    await send(
      `/api/artifacts/${doc.id}/reviews`,
      {
        expectedRevisionId: doc.currentRevisionId,
        decision: 'changes_requested',
        note: 'Add rollback.',
      },
      editorHeaders,
    );
    assert.equal(inspect().status, 'changes_requested');
    const next = await call('update_artifact', {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '# Plan\n\nRollback included.',
    });
    assert.equal(inspect().outdated, true);
    assert.equal(inspect().status, 'changes_requested');
    assert.equal((await send(path, input)).status, 409);
    assert.equal(
      (
        await client.callTool({
          name: 'renew_review_request',
          arguments: {
            requestId: request.id,
            expectedVersion: request.version,
            expectedRevisionId: doc.currentRevisionId,
          },
        })
      ).isError,
      true,
    );
    const renewed = await call('renew_review_request', {
      requestId: request.id,
      expectedVersion: request.version,
      expectedRevisionId: next.currentRevisionId,
    });
    assert.equal(renewed.status, 'waiting');
    assert.equal(renewed.baseRevisionId, doc.currentRevisionId);
    assert.equal(renewed.supersedesId, request.id);
    assert.equal(inspect().status, 'superseded');
    assert.equal(inspect().decision!.note, 'Add rollback.');
    assert.equal(
      (
        await client.callTool({
          name: 'renew_review_request',
          arguments: {
            requestId: request.id,
            expectedVersion: request.version,
            expectedRevisionId: next.currentRevisionId,
          },
        })
      ).isError,
      true,
    );
    const before = await call('list_review_requests', {
      workspaceId: f.workspace.id,
      artifactId: doc.id,
    });
    assert.equal(before.length, 2);
    await send(
      `/api/artifacts/${doc.id}/reviews`,
      {
        expectedRevisionId: next.currentRevisionId,
        decision: 'approved',
        note: 'Ready.',
      },
      editorHeaders,
    );
    assert.equal(f.store.reviewRequest(f.owner, renewed.id).status, 'approved');
    await send(
      `/api/artifacts/${doc.id}/reviews`,
      { expectedRevisionId: next.currentRevisionId, decision: 'withdrawn' },
      editorHeaders,
    );
    assert.equal(f.store.reviewRequest(f.owner, renewed.id).status, 'waiting');
    await send(
      `/api/artifacts/${doc.id}/reviews`,
      { expectedRevisionId: next.currentRevisionId, decision: 'approved' },
      editorHeaders,
    );
    const again = await call('renew_review_request', {
      requestId: renewed.id,
      expectedVersion: renewed.version,
      expectedRevisionId: next.currentRevisionId,
    });
    assert.equal(
      again.status,
      'waiting',
      'previous approval cannot fulfill a fresh request',
    );
    const outside = f.store.createWorkspace(f.owner, { name: 'Private' });
    const outsiderKey = f.store.createToken(f.owner, outside.id, {
      name: 'Private agent',
      scope: 'write',
    });
    assert.equal(
      (
        await f.request(`/api/review-requests/${again.id}`, {
          headers: { Authorization: `Bearer ${outsiderKey.token}` },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(`/api/workspaces/${outside.id}/reviewers`, {
          headers: editorHeaders,
        })
      ).status,
      404,
    );
    await send(
      `/api/artifacts/${doc.id}/reviews`,
      {
        expectedRevisionId: next.currentRevisionId,
        decision: 'changes_requested',
        note: 'New round feedback',
      },
      editorHeaders,
    );
    assert.equal(
      f.store.reviewRequest(f.owner, renewed.id).decision?.decision,
      'approved',
      'a superseded round keeps its outcome even when a later round reviews the same revision',
    );
    await send(
      `/api/artifacts/${doc.id}/reviews`,
      { expectedRevisionId: next.currentRevisionId, decision: 'withdrawn' },
      editorHeaders,
    );
    // Losing membership removes both review eligibility and read access, retaining audit history.
    f.store.removeMember(f.owner, f.workspace.id, editor.user.id);
    assert.equal(
      f.store.reviewRequest(f.owner, again.id).status,
      'reviewer_unavailable',
    );
    assert.equal(
      (
        await f.request(`/api/review-requests/${again.id}`, {
          headers: editorHeaders,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await send(`/api/review-requests/${again.id}/cancel`, {
          expectedVersion: again.version,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await send(`/api/review-requests/${again.id}/cancel`, {
          expectedVersion: again.version,
        })
      ).status,
      409,
    );
    const human = await send(path, {
      ...input,
      expectedRevisionId: next.currentRevisionId,
      reviewerId: f.owner.user.id,
    });
    assert.equal(human.status, 201);
    const humanRequest = await human.json();
    assert.equal(
      (
        await client.callTool({
          name: 'cancel_review_request',
          arguments: {
            requestId: humanRequest.id,
            expectedVersion: humanRequest.version,
          },
        })
      ).isError,
      true,
    );
    const reopened = new Store(f.filename);
    try {
      assert.equal(
        reopened.reviewRequest(f.owner, again.id).status,
        'cancelled',
      );
      assert.equal(
        reopened.reviewRequest(f.owner, request.id).revisionId,
        doc.currentRevisionId,
      );
      assert.equal(
        reopened.reviewRequest(f.owner, renewed.id).supersededBy,
        again.id,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await client.close();
    await f.close();
  }
});

test('comment submission retries are durable, scoped to the author, and never resurrect deleted discussions', async () => {
  const f = await fixture();
  try {
    const login = await f.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'owner-password-1234',
      }),
    });
    const headers = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0],
    };
    const doc = f.store.artifacts(f.owner, f.workspace.id)[0];
    const input = {
      submissionId: crypto.randomUUID(),
      revisionId: doc.currentRevisionId,
      body: 'Keep one durable discussion.',
    };
    const path = `/api/artifacts/${doc.id}/comments`;
    const submit = (body = input, auth = headers) =>
      f.request(path, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(body),
      });
    const saved = await submit();
    assert.equal(saved.status, 201);
    const comment = await saved.json();
    const retry = await submit();
    assert.equal(retry.status, 201);
    assert.equal((await retry.json()).id, comment.id);
    assert.equal(
      (await submit({ ...input, body: 'Different feedback' })).status,
      409,
    );
    const reopened = new Store(f.filename);
    try {
      assert.equal(
        (await reopened.addComment(f.owner, { ...input, artifactId: doc.id })).id,
        comment.id,
      );
    } finally {
      reopened.close();
    }
    const invite = f.store.invite(f.owner, f.workspace.id, {
      role: 'editor',
    });
    const registration = await f.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Other editor',
        email: 'retry@example.test',
        password: 'another-password-1234',
        invitation: invite.token,
      }),
    });
    assert.equal(registration.status, 200);
    const otherHeaders = {
      Cookie: registration.headers.get('set-cookie')!.split(';')[0],
    };
    assert.equal((await submit(input, otherHeaders)).status, 409);
    // Delete after the original response was lost: a later retry must not recreate it.
    const deleted = await f.request(`/api/comments/${comment.id}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ expectedVersion: comment.version }),
    });
    assert.equal(deleted.status, 200);
    const afterDelete = await submit();
    assert.equal(afterDelete.status, 409);
    assert.equal((await afterDelete.json()).code, 'comment_deleted');
    assert.equal(f.store.comments(f.owner, doc.id).length, 0);
    await f.request('/api/auth/logout', { method: 'POST', headers });
    assert.equal((await submit()).status, 401);
  } finally {
    await f.close();
  }
});

test('health verifies the database and maintenance pauses browser and MCP writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pw-maintenance-'));
  const marker = join(directory, 'maintenance');
  const f = await fixture({
    maintenanceFile: marker,
    release: 'hosting-test',
  });
  try {
    assert.deepEqual(await (await f.request('/api/health')).json(), {
      ok: true,
      release: 'hosting-test',
      version,
      commit: process.env.SOURCE_COMMIT ?? 'development',
      maintenance: false,
    });
    const login = await f.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'owner-password-1234',
      }),
    });
    const headers = {
      Cookie: login.headers.get('set-cookie')!.split(';')[0],
    };
    writeFileSync(marker, '');
    assert.equal(
      (await (await f.request('/api/health')).json()).maintenance,
      true,
    );
    const doc = f.store.artifacts(f.owner, f.workspace.id)[0];
    const response = await f.request(`/api/artifacts/${doc.id}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        revisionId: doc.currentRevisionId,
        body: 'Must wait',
      }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'maintenance');
    assert.equal(
      (
        await f.request('/mcp', {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
          }),
        })
      ).status,
      503,
    );
    assert.equal(f.store.comments(f.owner, doc.id).length, 0);
    unlinkSync(marker);
    assert.equal((await f.request('/api/health')).status, 200);
    // A real database failure must fail readiness, rather than always returning ok.
    f.store.db.exec('ALTER TABLE artifacts RENAME TO temporarily_unavailable');
    assert.equal((await f.request('/api/health')).status, 503);
    f.store.db.exec('ALTER TABLE temporarily_unavailable RENAME TO artifacts');
    assert.equal((await f.request('/api/health')).status, 200);
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('organization administration preserves isolation, combines team access, transfers ownership and offboards across HTTP and MCP', async () => {
  const f = await fixture();
  const client = new Client({ name: 'company-agent', version: '1' });
  try {
    const ownerAuth = { Cookie: `pw_session=${f.store.session(f.owner.user)}` };
    const send = async (
      path: string,
      body: unknown,
      headers: Record<string, string> = ownerAuth,
      method = 'POST',
    ) => f.request(path, { method, headers, body: JSON.stringify(body) });
    const change = async (
      path: string,
      body: Record<string, unknown>,
      expected = 200,
    ) => {
      const version = f.store.organization(f.owner).version;
      const response = await send(path, { ...body, expectedVersion: version });
      assert.equal(response.status, expected, await response.clone().text());
      return response.json();
    };
    const invite = f.store.invite(f.owner, f.workspace.id, { role: 'viewer' });
    const teammate = {
      user: await f.store.register({
        name: 'Company teammate',
        email: 'company@example.test',
        password: 'company-password-1234',
        invitation: invite.token,
      }),
    };
    const teammateAuth = {
      Cookie: `pw_session=${f.store.session(teammate.user)}`,
    };
    const privateWorkspace = f.store.createWorkspace(teammate, {
      name: 'Teammate private workspace',
    });
    const privateDoc = f.store.createArtifact(teammate, {
      workspaceId: privateWorkspace.id,
      path: 'private.md',
      body: '# Private history',
    });
    assert.equal(
      (
        await f.request(`/api/artifacts/${privateDoc.id}`, {
          headers: ownerAuth,
        })
      ).status,
      404,
      'org administration grants no implicit artifact access',
    );
    assert.equal(
      (await f.request('/api/organization/admin', { headers: teammateAuth }))
        .status,
      403,
    );
    assert.equal(
      (await f.request('/api/organization/audit', { headers: teammateAuth }))
        .status,
      403,
    );
    assert.equal(
      (
        await send(
          '/api/organization/teams',
          {
            name: 'Escalation',
            memberIds: [],
            workspaces: [],
            expectedVersion: 1,
          },
          teammateAuth,
        )
      ).status,
      403,
    );
    await change(
      `/api/organization/people/${f.owner.user.id}/role`,
      { role: 'member' },
      409,
    );
    await change(
      `/api/workspaces/${f.workspace.id}/membership`,
      { userId: f.owner.user.id, role: 'editor' },
      409,
    );
    await change(
      '/api/organization/teams',
      {
        name: 'Product',
        memberIds: [teammate.user.id],
        workspaces: [{ workspaceId: f.workspace.id, role: 'editor' }],
      },
      201,
    );
    const team = f.store.organizationAdmin(f.owner).teams[0];
    assert.equal(f.store.access(teammate, f.workspace.id), 'editor');
    assert.equal(
      f.store
        .members(f.owner, f.workspace.id)
        .find((m) => m.id === teammate.user.id)?.directRole,
      'viewer',
    );
    assert.ok(
      f.store
        .reviewers(f.owner, f.workspace.id)
        .some((m) => m.id === teammate.user.id),
    );
    const key = f.store.createToken(teammate, f.workspace.id, {
      name: 'Company agent',
      scope: 'write',
    });
    const bearer = { Authorization: `Bearer ${key.token}` };
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: { headers: bearer },
      }),
    );
    assert.equal(
      (await f.request('/api/organization/admin', { headers: bearer })).status,
      403,
    );
    assert.equal(
      (
        await send(
          `/api/workspaces/${f.workspace.id}/membership`,
          {
            userId: teammate.user.id,
            role: 'owner',
            expectedVersion: f.store.organization(f.owner).version,
          },
          bearer,
        )
      ).status,
      403,
    );
    const doc = f.store.artifacts(f.owner, f.workspace.id)[0];
    const request = f.store.requestReview(f.owner, {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      reviewerId: teammate.user.id,
    });
    const result = await client.callTool({
      name: 'create_comment',
      arguments: {
        artifactId: doc.id,
        revisionId: doc.currentRevisionId,
        body: 'Keep this team contribution.',
      },
    });
    assert.equal(result.isError, undefined);
    const staleVersion = f.store.organization(f.owner).version;
    await change('/api/organization', { name: 'Our company' });
    assert.equal(
      (
        await send(`/api/organization/teams/${team.id}`, {
          expectedVersion: staleVersion,
          name: 'Wrong overwrite',
          memberIds: [],
          workspaces: [],
        })
      ).status,
      409,
    );
    assert.equal(f.store.organizationAdmin(f.owner).teams[0].name, 'Product');
    await change(`/api/organization/teams/${team.id}`, {
      name: 'Product',
      memberIds: [teammate.user.id],
      workspaces: [{ workspaceId: f.workspace.id, role: 'viewer' }],
    });
    assert.equal(
      f.store.reviewRequest(f.owner, request.id).status,
      'reviewer_unavailable',
    );
    assert.equal(
      (
        await client.callTool({
          name: 'create_comment',
          arguments: {
            artifactId: doc.id,
            revisionId: doc.currentRevisionId,
            body: 'No more write access.',
          },
        })
      ).isError,
      true,
    );
    await change(`/api/workspaces/${f.workspace.id}/membership`, {
      userId: teammate.user.id,
      role: null,
    });
    assert.equal(
      f.store.access(teammate, f.workspace.id),
      'viewer',
      'removing direct membership leaves inherited team access',
    );
    await change(`/api/organization/teams/${team.id}`, {
      name: 'Product',
      memberIds: [],
      workspaces: [{ workspaceId: f.workspace.id, role: 'editor' }],
    });
    assert.equal(
      f.store.tokenActor(key.token),
      undefined,
      'last access removal permanently revokes scoped credentials',
    );
    assert.equal(
      (await f.request(`/api/artifacts/${doc.id}`, { headers: teammateAuth }))
        .status,
      404,
    );
    await change(`/api/organization/teams/${team.id}`, {
      name: 'Product',
      memberIds: [teammate.user.id],
      workspaces: [{ workspaceId: f.workspace.id, role: 'editor' }],
    });
    assert.equal(
      f.store.tokenActor(key.token),
      undefined,
      'regaining membership cannot revive revoked keys',
    );
    await change(`/api/workspaces/${f.workspace.id}/ownership`, {
      fromUserId: f.owner.user.id,
      toUserId: teammate.user.id,
    });
    assert.equal(f.store.access(f.owner, f.workspace.id), 'editor');
    assert.equal(f.store.access(teammate, f.workspace.id), 'owner');
    const issuedInvite = f.store.invite(teammate, f.workspace.id, {
      role: 'editor',
    });
    const privateKey = f.store.createToken(teammate, privateWorkspace.id, {
      name: 'Private agent',
      scope: 'write',
    });
    const secondSession = f.store.session(teammate.user);
    await change(
      `/api/organization/people/${teammate.user.id}/offboard`,
      {},
      409,
    );
    assert.ok(
      f.store.sessionActor(secondSession),
      'rejected offboarding must not partially revoke access',
    );
    await change(`/api/organization/people/${teammate.user.id}/offboard`, {
      successorId: f.owner.user.id,
    });
    assert.equal(
      (await f.request('/api/workspaces', { headers: teammateAuth })).status,
      401,
    );
    assert.equal(
      (
        await f.request('/api/workspaces', {
          headers: { Authorization: `Bearer ${privateKey.token}` },
        })
      ).status,
      401,
    );
    assert.equal(f.store.sessionActor(secondSession), undefined);
    assert.equal(
      (
        await send('/api/auth/login', {
          email: teammate.user.email,
          password: 'company-password-1234',
        })
      ).status,
      401,
    );
    assert.throws(() => f.store.inspectInvite(issuedInvite.token));
    assert.equal(
      f.store.artifact(f.owner, privateDoc.id).revision.body,
      '# Private history',
    );
    assert.equal(
      f.store.comments(f.owner, doc.id)[0].body,
      'Keep this team contribution.',
    );
    assert.equal(
      f.store.organizationAdmin(f.owner).teams[0].memberIds.length,
      0,
    );
    await change(`/api/organization/people/${teammate.user.id}/reactivate`, {});
    assert.equal(f.store.workspaces(teammate).length, 0);
    assert.equal(f.store.sessionActor(secondSession), undefined);
    assert.equal(f.store.tokenActor(privateKey.token), undefined);
    await change(`/api/organization/people/${teammate.user.id}/role`, {
      role: 'admin',
    });
    const adminToken = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Inventory test',
      scope: 'read',
    });
    const inventory = await (
      await f.request('/api/organization/admin', { headers: ownerAuth })
    ).json();
    assert.ok(
      inventory.credentials.some((t: { id: string }) => t.id === adminToken.id),
    );
    assert.doesNotMatch(
      JSON.stringify(inventory),
      new RegExp(adminToken.token),
    );
    await change(`/api/organization/credentials/${adminToken.id}/revoke`, {});
    assert.equal(f.store.tokenActor(adminToken.token), undefined);
    const log = await (
      await f.request('/api/organization/audit', { headers: ownerAuth })
    ).json();
    assert.ok(
      log.entries.some(
        (e: { action: string; actorName: string }) =>
          e.action === 'account.offboarded' && e.actorName === 'Owner',
      ),
    );
    assert.doesNotMatch(JSON.stringify(log), /company-password-1234|pw_/);
    const reopened = new Store(f.filename);
    try {
      assert.equal(reopened.organization(f.owner).name, 'Our company');
      assert.equal(
        reopened.organizationAdmin(f.owner).teams[0].name,
        'Product',
      );
      assert.equal(
        reopened.auditLog(f.owner).entries.length,
        log.entries.length,
      );
      assert.equal(reopened.tokenActor(privateKey.token), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    await client.close();
    await f.close();
  }
});

test('discovery, archive lifecycle and notifications respect current access through HTTP and MCP', async () => {
  const f = await fixture();
  const client = new Client({ name: 'discovery-test', version: '1' });
  try {
    const ownerHeaders = {
      Cookie: `pw_session=${f.store.session(f.owner.user)}`,
    };
    const invitation = f.store.invite(f.owner, f.workspace.id, {
      role: 'editor',
    });
    const teammate = {
      user: await f.store.register({
        name: 'Reader',
        email: 'reader@example.test',
        password: 'reader-password-1234',
        invitation: invitation.token,
      }),
    };
    const readerHeaders = {
      Cookie: `pw_session=${f.store.session(teammate.user)}`,
    };
    const request = async (
      path: string,
      body?: unknown,
      headers = ownerHeaders,
      method = body === undefined ? 'GET' : 'POST',
    ) =>
      f.request('/api' + path, {
        headers,
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const json = async (
      path: string,
      body?: unknown,
      headers = ownerHeaders,
      method?: string,
    ) => {
      const r = await request(path, body, headers, method);
      assert.equal(
        r.status,
        body === undefined || method === 'PATCH' ? 200 : 201,
        await r.clone().text(),
      );
      return r.json();
    };
    const doc = await json('/artifacts', {
      workspaceId: f.workspace.id,
      path: 'plans/launch.md',
      body: '# Sequoia\n\nUnique launch schedule',
    });
    const hidden = f.store.createWorkspace(teammate, {
      name: 'Private research',
    });
    const privateDoc = f.store.createArtifact(teammate, {
      workspaceId: hidden.id,
      path: 'private.md',
      body: '# Sequoia secrets',
    });
    assert.deepEqual(
      (await json('/search?query=sequoia')).map((d: any) => d.id),
      [doc.id],
    );
    assert.equal(
      (await request(`/search?query=sequoia&workspaceId=${hidden.id}`)).status,
      404,
    ); // even org admin
    assert.equal(
      (await json('/search?query=sequoia', undefined, readerHeaders)).length,
      2,
    );
    const key = f.store.createToken(teammate, f.workspace.id, {
      name: 'Scoped search',
      scope: 'write',
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
    const result = await call('search_artifacts', { query: 'sequoia' });
    assert.deepEqual(
      (result.structuredContent as any).result.map((d: any) => d.id),
      [doc.id],
    );
    assert.equal(
      (await call('read_artifact', { artifactId: privateDoc.id })).isError,
      true,
    );
    const renamed = await json(
      `/artifacts/${doc.id}`,
      {
        path: 'approved/release.md',
        expectedRevisionId: doc.currentRevisionId,
        expectedMetadataVersion: doc.metadataVersion,
      },
      ownerHeaders,
      'PATCH',
    );
    assert.equal(renamed.currentRevisionId, doc.currentRevisionId);
    assert.equal((await json('/search?query=approved'))[0].id, doc.id);
    assert.equal(
      (await json('/search?query=plans')).some((d: any) => d.id === doc.id),
      false,
    );
    assert.equal(
      (
        await request(
          `/artifacts/${doc.id}`,
          {
            archived: true,
            expectedRevisionId: doc.currentRevisionId,
            expectedMetadataVersion: doc.metadataVersion,
          },
          ownerHeaders,
          'PATCH',
        )
      ).status,
      409,
    );
    const review = await json(`/artifacts/${doc.id}/review-requests`, {
      expectedRevisionId: doc.currentRevisionId,
      reviewerId: teammate.user.id,
      message: 'Check the launch',
    });
    const second = f.store.createWorkspace(f.owner, {
      name: 'Second workspace',
    });
    f.store.acceptInvite(
      teammate.user,
      f.store.invite(f.owner, second.id, { role: 'editor' }).token,
    );
    const another = f.store.createArtifact(f.owner, {
      workspaceId: second.id,
      path: 'second.md',
      body: '# Second',
    });
    f.store.requestReview(f.owner, {
      artifactId: another.id,
      expectedRevisionId: another.currentRevisionId,
      reviewerId: teammate.user.id,
    });
    assert.equal(
      (await json('/my-reviews', undefined, readerHeaders)).length,
      2,
    );
    assert.equal(
      (await json('/notifications', undefined, readerHeaders)).unreadCount,
      2,
    );
    assert.equal((await json('/notifications')).unreadCount, 0);
    const comment = await json(`/artifacts/${doc.id}/comments`, {
      revisionId: doc.currentRevisionId,
      body: 'Discuss schedule',
    });
    await json(
      `/comments/${comment.id}/replies`,
      { body: 'Schedule looks good' },
      readerHeaders,
    );
    let notices = await json('/notifications');
    assert.equal(notices.items[0].commentId, comment.id);
    assert.equal(notices.unreadCount, 1);
    assert.equal(
      (
        await request(
          '/notifications/read',
          { id: notices.items[0].id },
          readerHeaders,
        )
      ).status,
      200,
    );
    assert.equal((await json('/notifications')).unreadCount, 1); // cannot mark someone else’s notification
    await request('/notifications/read', { id: notices.items[0].id });
    assert.equal((await json('/notifications')).unreadCount, 0);
    const archived = await json(
      `/artifacts/${doc.id}`,
      {
        archived: true,
        expectedRevisionId: doc.currentRevisionId,
        expectedMetadataVersion: renamed.metadataVersion,
      },
      ownerHeaders,
      'PATCH',
    );
    assert.equal(
      (await json(`/workspaces/${f.workspace.id}/artifacts`)).some(
        (d: any) => d.id === doc.id,
      ),
      false,
    );
    assert.equal((await json('/search?query=sequoia')).length, 0);
    assert.equal(
      (await json('/search?query=sequoia&includeArchived=true'))[0].id,
      doc.id,
    );
    assert.equal(
      (await json(`/review-requests/${review.id}`)).status,
      'artifact_archived',
    );
    assert.equal(
      (
        await call('update_artifact', {
          artifactId: doc.id,
          expectedRevisionId: doc.currentRevisionId,
          body: 'No',
        })
      ).isError,
      true,
    );
    assert.equal(
      (await request(`/comments/${comment.id}/replies`, { body: 'No writes' }))
        .status,
      409,
    );
    assert.equal(
      (
        await request(`/artifacts/${doc.id}/reviews`, {
          expectedRevisionId: doc.currentRevisionId,
          decision: 'approved',
        })
      ).status,
      409,
    );
    assert.equal(
      (await json(`/artifacts/${doc.id}`)).revision.body,
      doc.revision.body,
    );
    await json(
      `/artifacts/${doc.id}`,
      {
        archived: false,
        expectedRevisionId: doc.currentRevisionId,
        expectedMetadataVersion: archived.metadataVersion,
      },
      ownerHeaders,
      'PATCH',
    );
    assert.equal(
      (await json(`/review-requests/${review.id}`)).status,
      'waiting',
    );
    const updated = await request(
      `/artifacts/${doc.id}`,
      {
        expectedRevisionId: doc.currentRevisionId,
        body: '# Juniper\n\nNew revision',
      },
      ownerHeaders,
      'PUT',
    );
    assert.equal(updated.status, 200);
    assert.equal((await json('/search?query=sequoia')).length, 0);
    assert.equal((await json('/search?query=juniper'))[0].id, doc.id);
    f.store.changeMember(f.owner, f.workspace.id, {
      userId: teammate.user.id,
      role: null,
      expectedVersion: f.store.organization(f.owner).version,
    });
    assert.equal(
      (await json('/notifications', undefined, readerHeaders)).items.some(
        (n: any) => n.artifactId === doc.id,
      ),
      false,
    );
    assert.equal(
      (await json('/my-reviews', undefined, readerHeaders)).length,
      1,
    );
    assert.equal(
      (await request('/search?query=juniper', undefined, readerHeaders)).status,
      200,
    );
    assert.equal(
      (await json('/search?query=juniper', undefined, readerHeaders)).length,
      0,
    );
  } finally {
    await client.close();
    await f.close();
  }
});

test('workspace service identities use real MCP, survive creator offboarding, and cannot become people or administrators', async () => {
  const f = await fixture();
  const client = new Client({ name: 'unattended', version: '1' });
  try {
    const invitation = f.store.invite(f.owner, f.workspace.id, {
      role: 'editor',
    });
    const creator = {
      user: await f.store.register({
        name: 'Automation maintainer',
        email: 'automation@example.test',
        password: 'creator-password-1234',
        invitation: invitation.token,
      }),
    };
    f.store.changeMember(f.owner, f.workspace.id, {
      userId: creator.user.id,
      role: 'owner',
      expectedVersion: f.store.organization(f.owner).version,
    });
    const creatorHeaders = {
      Cookie: `pw_session=${f.store.session(creator.user)}`,
    };
    const ownerHeaders = {
      Cookie: `pw_session=${f.store.session(f.owner.user)}`,
    };
    const request = (
      path: string,
      body?: unknown,
      headers = creatorHeaders,
      method = body === undefined ? 'GET' : 'POST',
    ) =>
      f.request('/api' + path, {
        headers,
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const base = `/workspaces/${f.workspace.id}/service-accounts`;
    const response = await request(base, {
      name: 'Release bot',
      scope: 'write',
    });
    assert.equal(response.status, 201);
    const account = await response.json();
    const keyResponse = await request(`${base}/${account.id}/tokens`, {
      name: 'Nightly runner',
      scope: 'write',
    });
    assert.equal(keyResponse.status, 201);
    const key = await keyResponse.json();
    assert.equal(f.store.user(account.id), undefined);
    assert.equal(
      f.store
        .reviewers(f.owner, f.workspace.id)
        .some((u) => u.id === account.id),
      false,
    );
    assert.equal(
      f.store
        .organizationAdmin(f.owner)
        .people.some((u) => u.id === account.id),
      false,
    );
    assert.throws(() =>
      f.store.session({
        id: account.id,
        name: account.name,
        email: account.id + '@service.invalid',
      }),
    );
    const agentHeaders = { Authorization: `Bearer ${key.token}` };
    for (const path of [
      base,
      `/workspaces/${f.workspace.id}/tokens`,
      '/workspaces',
    ]) {
      assert.equal(
        (
          await request(
            path,
            { name: 'Forbidden', scope: 'write' },
            agentHeaders as any,
          )
        ).status,
        403,
      );
    }
    assert.equal(
      (await request('/notifications', undefined, agentHeaders as any)).status,
      403,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: { headers: agentHeaders },
      }),
    );
    const info = await client.callTool({
      name: 'connection_info',
      arguments: {},
    });
    assert.equal(
      (info.structuredContent as any).result.credential.ownerType,
      'service',
    );
    assert.ok(
      f.store.serviceAccounts(f.owner, f.workspace.id)[0].tokens[0].lastUsedAt,
    );
    const created = await client.callTool({
      name: 'create_artifact',
      arguments: {
        workspaceId: f.workspace.id,
        path: 'automation.md',
        body: '# Automated report',
      },
    });
    assert.equal(created.isError, undefined);
    const doc = (created.structuredContent as any).result;
    assert.equal(doc.revision.authorName, 'Release bot');
    assert.equal(doc.revision.agentName, 'Nightly runner');
    assert.equal(
      (
        await request(
          `/artifacts/${doc.id}/reviews`,
          { expectedRevisionId: doc.currentRevisionId, decision: 'approved' },
          agentHeaders as any,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/organization/teams',
          {
            name: 'No bots',
            memberIds: [account.id],
            workspaces: [],
            expectedVersion: f.store.organization(f.owner).version,
          },
          ownerHeaders,
        )
      ).status,
      400,
    );
    f.store.offboard(f.owner, creator.user.id, {
      expectedVersion: f.store.organization(f.owner).version,
    });
    assert.equal(
      (
        await client.callTool({
          name: 'read_artifact',
          arguments: { artifactId: doc.id },
        })
      ).isError,
      undefined,
    );
    assert.equal((await request(base)).status, 401);
    assert.equal(
      (await request(`${base}/${account.id}/disable`, {}, ownerHeaders)).status,
      200,
    );
    assert.equal(
      (await request(`/artifacts/${doc.id}`, undefined, agentHeaders as any))
        .status,
      401,
    );
    assert.equal(
      f.store.serviceAccounts(f.owner, f.workspace.id)[0].tokens.length,
      0,
    );
    assert.ok(
      f.store
        .auditLog(f.owner)
        .entries.some((e) => e.action === 'service_account.disabled'),
    );
    assert.equal(
      (
        await request(
          `/organization/people/${account.id}/reactivate`,
          { expectedVersion: f.store.organization(f.owner).version },
          ownerHeaders,
        )
      ).status,
      404,
    );
  } finally {
    await client.close();
    await f.close();
  }
});

test('folder changes cross HTTP and MCP atomically, preserve links, and enforce scope and stale snapshots', async () => {
  const f = await fixture();
  const client = new Client({ name: 'folder-integration', version: '1' });
  try {
    const key = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Folder editor',
      scope: 'write',
    });
    const headers = { Authorization: `Bearer ${key.token}` };
    const request = async (path: string, data?: unknown, method = 'POST') =>
      f.request(path, {
        headers,
        method,
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
    const create = async (path: string, data: unknown) => {
      const r = await request(path, data);
      assert.equal(r.status, 201, await r.clone().text());
      return r.json();
    };
    const parent = await create(`/api/workspaces/${f.workspace.id}/folders`, {
      name: 'Plans',
    });
    const nested = await create(`/api/workspaces/${f.workspace.id}/folders`, {
      name: 'Launch',
      parentId: parent.id,
    });
    const archive = await create(`/api/workspaces/${f.workspace.id}/folders`, {
      name: 'Archive',
    });
    const doc = await create('/api/artifacts', {
      workspaceId: f.workspace.id,
      path: 'Plans/Launch/proposal.md',
      body: '# Proposal',
    });
    const source = await create('/api/artifacts', {
      workspaceId: f.workspace.id,
      path: 'index.md',
      body: '[Proposal](Plans/Launch/proposal.md)',
    });
    const snapshot = () => f.store.catalog(f.owner, f.workspace.id);
    const change = (catalog: ReturnType<typeof snapshot>, extra = {}) => ({
      workspaceId: f.workspace.id,
      folderId: parent.id,
      expectedCatalogVersion: catalog.version,
      expectedArtifacts: catalog.artifacts
        .filter((a) => a.id === doc.id)
        .map((a) => ({
          id: a.id,
          expectedRevisionId: a.currentRevisionId,
          expectedMetadataVersion: a.metadataVersion,
        })),
      ...extra,
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: { headers },
      }),
    );
    const stale = snapshot();
    const newer = f.store.updateArtifact(f.owner, {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '# Revised',
    });
    let result = await client.callTool({
      name: 'change_folder',
      arguments: change(stale, { name: 'Decisions' }),
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /revision_conflict/);
    assert.equal(
      f.store.artifact(f.owner, doc.id).path,
      'Plans/Launch/proposal.md',
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/${f.workspace.id}/folders/${parent.id}`,
          change(snapshot(), { parentId: nested.id }),
          'PATCH',
        )
      ).status,
      400,
    );
    // A destination already used by another artifact's history must roll back the whole move.
    const conflict = await create('/api/artifacts', {
      workspaceId: f.workspace.id,
      path: 'Decisions/Launch/proposal.md',
      body: '# Taken',
    });
    result = await client.callTool({
      name: 'change_folder',
      arguments: change(snapshot(), { name: 'Decisions' }),
    });
    assert.equal(result.isError, true);
    assert.equal(
      snapshot().folders.find((x) => x.id === parent.id)!.name,
      'Plans',
    );
    assert.equal(
      f.store.artifact(f.owner, conflict.id).path,
      'Decisions/Launch/proposal.md',
    );
    const before = snapshot();
    result = await client.callTool({
      name: 'change_folder',
      arguments: change(before, { name: 'Approved', parentId: archive.id }),
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const moved = f.store.artifact(f.owner, doc.id);
    assert.equal(moved.path, 'Archive/Approved/Launch/proposal.md');
    assert.equal(moved.folderId, nested.id);
    assert.equal(moved.currentRevisionId, newer.currentRevisionId);
    assert.equal(moved.metadataVersion, doc.metadataVersion + 1);
    assert.equal(
      f.store.resolveLink(f.owner, source.id, {
        revisionId: source.currentRevisionId,
        href: 'Plans/Launch/proposal.md',
      }).artifactId,
      doc.id,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/${f.workspace.id}/folders/${parent.id}`,
          change(before, { name: 'Old snapshot' }),
          'PATCH',
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/workspaces/${f.workspace.id}/folders/${parent.id}`,
          change(snapshot(), { remove: true }),
          'PATCH',
        )
      ).status,
      409,
    );
    // Old REST URLs keep their old response field spelling while canonical URLs use artifacts.
    const legacy = await (
      await request(`/api/documents/${doc.id}`, undefined, 'GET')
    ).json();
    assert.equal(legacy.revision.documentId, doc.id);
    assert.equal(legacy.revision.artifactId, undefined);
    const other = f.store.createWorkspace(f.owner, {
      name: 'Outside key scope',
    });
    assert.equal(
      (
        await request(`/api/workspaces/${other.id}/folders`, {
          name: 'Forbidden',
        })
      ).status,
      404,
    );
    const read = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Reader',
      scope: 'read',
    });
    assert.equal(
      (
        await f.request(`/api/workspaces/${f.workspace.id}/folders`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${read.token}` },
          body: JSON.stringify({ name: 'Forbidden' }),
        })
      ).status,
      403,
    );
    const empty = await create(`/api/workspaces/${f.workspace.id}/folders`, {
      name: 'Empty',
    });
    assert.equal(
      (
        await request(
          `/api/workspaces/${f.workspace.id}/folders/${empty.id}`,
          { expectedCatalogVersion: snapshot().version, remove: true },
          'PATCH',
        )
      ).status,
      200,
    );
    assert.ok(
      f.store
        .auditLog(f.owner)
        .entries.some((a) => a.action === 'folder.updated'),
    );
    const reopened = new Store(f.filename);
    assert.equal(reopened.artifact(f.owner, doc.id).folderId, nested.id);
    assert.ok(
      reopened
        .catalog(f.owner, f.workspace.id)
        .folders.some((x) => x.id === parent.id),
    );
    reopened.close();
  } finally {
    await client.close();
    await f.close();
  }
});

test('all upstream artifact formats round-trip through HTTP and MCP with HTML anchors and revision safety', async () => {
  const f = await fixture();
  const client = new Client({ name: 'artifact-review', version: '1.0' });
  try {
    const login = await f.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.test',
        password: 'owner-password-1234',
      }),
    });
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
    const key = f.store.createToken(f.owner, f.workspace.id, {
      name: 'Artifact agent',
      scope: 'write',
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return (result.structuredContent as { result: any }).result;
    };
    const extensions = [
      'md',
      'mdx',
      'txt',
      'html',
      'htm',
      'mmd',
      'mermaid',
      'dot',
      'gv',
      'yaml',
      'yml',
      'json',
      'jsonc',
      'json5',
      'toml',
      'ini',
      'cfg',
      'conf',
      'properties',
      'csv',
      'tsv',
      'log',
      'xml',
      'env.example',
    ];
    for (const ext of extensions) {
      const body =
        ext === 'html'
          ? '<!doctype html><h1 id="design">Retry architecture</h1><a href="../target.html?a=1&amp;b=2">Details</a>'
          : ext === 'mmd'
            ? '---\nconfig: {}\n---\nflowchart LR\nAPI --> Worker\n'
            : '---\nartifact source\n---\n';
      const created = await call('create_artifact', {
        workspaceId: f.workspace.id,
        path: `specs/retry.${ext}`,
        body,
      });
      const read = await f.request(`/api/artifacts/${created.id}`, { headers });
      assert.equal(read.status, 200);
      assert.equal((await read.json()).revision.body, body);
      assert.equal(
        (await call('read_artifact', { artifactId: created.id })).revision.body,
        body,
      );
    }
    for (const path of ['bad.exe', 'secret.env', '../escape.html']) {
      const response = await f.request('/api/artifacts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspaceId: f.workspace.id,
          path,
          body: 'source',
        }),
      });
      assert.equal(response.status, 400);
    }
    const doc = f.store.artifact(
      f.owner,
      f.store
        .artifacts(f.owner, f.workspace.id)
        .find((a) => a.path === 'specs/retry.html')!.id,
    );
    const target = await call('create_artifact', {
      workspaceId: f.workspace.id,
      path: 'target.html',
      body: '<h1>Details</h1>',
    });
    const comment = await call('create_comment', {
      artifactId: doc.id,
      revisionId: doc.currentRevisionId,
      body: 'Bound the retry queue.',
      quote: 'Retry architecture',
      authorName: 'Forged',
      anchor: {
        htmlAnchor: {
          selector: '#design',
          tagName: 'h1',
          text: 'Retry architecture',
          point: { x: 0.5, y: 0.5 },
          injected: 'discard',
        },
        htmlAdditionalTargets: [
          {
            text: 'Details',
            anchor: { selector: 'a', tagName: 'a', injected: true },
          },
        ],
        elementContext: {
          tag: 'h1',
          id: 'design',
          attrs: { onclick: 'discard' },
          injected: 'discard',
        },
        forged: 'discard',
      },
    });
    assert.equal(comment.authorName, 'Owner');
    assert.equal(comment.agentName, 'Artifact agent');
    assert.equal(comment.anchor.htmlAnchor.selector, '#design');
    assert.equal(comment.anchor.htmlAnchor.injected, undefined);
    assert.equal(comment.anchor.elementContext.injected, undefined);
    assert.equal(comment.anchor.forged, undefined);
    const badAnchor = await client.callTool({
      name: 'create_comment',
      arguments: {
        artifactId: doc.id,
        revisionId: doc.currentRevisionId,
        body: 'Invalid',
        anchor: { htmlAnchor: { selector: '', tagName: 'h1' } },
      },
    });
    assert.equal(badAnchor.isError, true);
    const feedback = await f.request(
      `/api/artifacts/${doc.id}/revisions/${doc.currentRevisionId}/feedback`,
      { headers },
    );
    assert.match(await feedback.text(), /HTML element.*design/);
    const change = await f.request(`/api/artifacts/${doc.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        expectedRevisionId: doc.currentRevisionId,
        expectedMetadataVersion: doc.metadataVersion,
        path: 'renamed/deeper/retry.htm',
      }),
    });
    assert.equal(change.status, 200);
    const renamed = await change.json();
    const link = await f.request(
      `/api/artifacts/${doc.id}/resolve-link?` +
        new URLSearchParams({
          revisionId: doc.currentRevisionId,
          href: '../target.html?a=1&b=2',
        }),
      { headers },
    );
    assert.equal((await link.json()).artifactId, target.id);
    const conversion = await f.request(`/api/artifacts/${doc.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        expectedRevisionId: doc.currentRevisionId,
        expectedMetadataVersion: renamed.metadataVersion,
        path: 'retry.md',
      }),
    });
    assert.equal(conversion.status, 400);
    const update = {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '<h1 id="design">Updated architecture</h1>',
    };
    const changed = await call('update_artifact', update);
    assert.equal(
      (await client.callTool({ name: 'update_artifact', arguments: update }))
        .isError,
      true,
    );
    const restored = await f.request(`/api/artifacts/${doc.id}/restore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        revisionId: doc.currentRevisionId,
        expectedRevisionId: changed.currentRevisionId,
      }),
    });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).revision.body, doc.revision.body);
    const threads = await call('list_comments', { artifactId: doc.id });
    assert.equal(threads[0].revisionId, doc.currentRevisionId);
    assert.equal(
      threads[0].anchor.htmlAdditionalTargets[0].anchor.selector,
      'a',
    );
    assert.equal((await f.request(`/api/artifacts/${doc.id}`)).status, 401);
    assert.equal(
      (
        await f.request(`/api/artifacts/${doc.id}`, {
          headers: { ...headers, Origin: 'null' },
        })
      ).status,
      403,
    );
  } finally {
    await client.close();
    await f.close();
  }
});
