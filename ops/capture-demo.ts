// Build first. Uses a temporary database and an ephemeral loopback port;
// never reads production data or connects to the managed application.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chromium, expect } from '@playwright/test';
import { Store } from '../server/store.ts';
import { createApp } from '../server/app.ts';

const directory = mkdtempSync(join(tmpdir(), 'checkpoint-demo-'));
const store = new Store(join(directory, 'demo.sqlite'));
const server = createServer().listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No demo port.');
const origin = `http://127.0.0.1:${address.port}`;
server.on('request', createApp(store, { origins: [origin] }));
let browser;
try {
  const user = await store.setup({
    name: 'Maya Chen',
    email: 'maya@example.test',
    password: 'disposable-demo-password',
  });
  const human = { user };
  const workspace = store.createWorkspace(human, {
    name: 'Platform engineering',
  });
  const account = store.createServiceAccount(human, workspace.id, {
    name: 'Design agent',
    scope: 'write',
  });
  const key = store.createServiceToken(human, workspace.id, account.id, {
    name: 'Design agent',
    scope: 'write',
  });
  const agent = store.tokenActor(key.token)!;
  const body = readFileSync('docs/examples/webhook-delivery.md', 'utf8');
  const initial = store.createArtifact(agent, {
    workspaceId: workspace.id,
    path: 'specs/webhook-delivery.md',
    body: body.replace(
      'At-least-once delivery; preserve the delivery ID across retries.',
      'At-least-once delivery; retry failed attempts.',
    ),
  });
  const artifact = store.updateArtifact(agent, {
    artifactId: initial.id,
    expectedRevisionId: initial.currentRevisionId,
    body,
  });
  store.createArtifact(agent, {
    workspaceId: workspace.id,
    path: 'specs/event-contract.md',
    body: '# Event contract\n\nVersioned event envelopes with stable delivery IDs, tenant identity, and payload schema versions.',
  });
  store.createArtifact(agent, {
    workspaceId: workspace.id,
    path: 'decisions/outbox-pattern.md',
    body: '# Use a transactional outbox\n\nCommit events alongside application state. Dispatch asynchronously to keep customer endpoint failures outside the API transaction.',
  });
  const thread = store.addComment(human, {
    artifactId: artifact.id,
    revisionId: artifact.currentRevisionId,
    quote: 'At-least-once delivery; preserve the delivery ID across retries.',
    body: 'Treat timeouts as an unknown outcome. The receiver must deduplicate using the same ID on every attempt.',
  });
  store.reply(agent, {
    commentId: thread.id,
    body: 'Added stable delivery IDs in revision 2. I’ll also test a worker crash after delivery but before acknowledgment.',
  });
  store.addComment(human, {
    artifactId: artifact.id,
    revisionId: artifact.currentRevisionId,
    quote: 'Per-tenant concurrency limits and separate retry budgets.',
    body: 'What limit protects other tenants when one endpoint is slow? Include a two-tenant load test.',
  });
  store.requestReview(agent, {
    artifactId: artifact.id,
    expectedRevisionId: artifact.currentRevisionId,
    reviewerId: user.id,
    message:
      'Please review delivery guarantees and failure isolation before I implement the worker.',
  });
  store.review(human, {
    artifactId: artifact.id,
    expectedRevisionId: artifact.currentRevisionId,
    decision: 'changes_requested',
    note: 'Pin down tenant limits and replay semantics before implementation.',
  });
  browser = await chromium.launch();
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1080 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    await context.addCookies([
      { name: 'pw_session', value: store.session(user), url: origin },
    ]);
    const page = await context.newPage();
    await page.goto(
      `${origin}/?workspace=${workspace.id}&artifact=${artifact.id}`,
    );
    await expect(
      page.getByRole('heading', {
        name: 'Webhook delivery architecture',
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Review options', exact: true })
      .click();
    await page.getByRole('button', { name: 'Wide', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(
      page.locator('.artifact-surface svg .node').filter({ hasText: 'Outbox' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Design decisions', exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Wait for both the diagram layout and highlighting to settle.
    await page
      .getByRole('heading', {
        name: 'Webhook delivery architecture',
        exact: true,
      })
      .hover();
    await page
      .getByRole('button', { name: 'Review options', exact: true })
      .evaluate((button) => button.blur());
    await page.screenshot({
      path: `docs/images/checkpoint${theme === 'dark' ? '-dark' : ''}.png`,
      animations: 'disabled',
    });
    await context.close();
  }
  console.log('Captured light and dark engineering review demos.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
