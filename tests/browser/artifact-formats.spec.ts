import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { authenticate, appearance } from './controls';

const origin = 'http://127.0.0.1:4411';
const credentials = {
  name: 'Alex Morgan',
  email: 'alex@example.test',
  password: 'browser-test-password-1234',
};
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post('/api' + path, {
    headers: { Origin: origin },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function setup(page: Page, name: string) {
  const status = await (await page.request.get('/api/auth/status')).json();
  await authenticate(
    page.request,
    status.needsSetup ? '/auth/setup' : '/auth/login',
    credentials,
  );
  return post(page.request, '/workspaces', { name });
}

test('HTML import, isolated preview, persistent pinpoint feedback and source revision editing', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  const workspace = await setup(page, 'HTML review');
  const body = `<!doctype html><html><head><style>body{font:18px sans-serif;padding:30px;background:white;color:#172033} section{padding:24px;border:1px solid #aaa}</style></head><body><h1>Retry architecture</h1><section id="queue">Queue capacity is an open decision.</section><button id="simulate" onclick="this.textContent='Retry queued'">Simulate retry</button><p id="isolation">Checking isolation</p><script>try {parent.document.body.dataset.artifactEscape='bad';document.querySelector('#isolation').textContent='Unsafe';} catch {document.querySelector('#isolation').textContent='Preview script runs in isolation';}</script></body></html>`;
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByRole('button', { name: 'New artifact', exact: true }).click();
  await page.getByLabel('Import a file').setInputFiles({
    name: 'retry-console.html',
    mimeType: 'text/html',
    buffer: Buffer.from(body),
  });
  await expect(page.getByLabel('Starting content')).toHaveValue(body);
  await page
    .getByRole('button', { name: 'Create artifact', exact: true })
    .click();
  await expect(page).toHaveURL(/artifact=/);
  const url = page.url();
  const id = new URL(url).searchParams.get('artifact')!;
  const frame = page.frameLocator('iframe[title="HTML artifact preview"]');
  await expect(
    frame.getByText('Preview script runs in isolation'),
  ).toBeVisible();
  await expect(
    page.locator('iframe[title="HTML artifact preview"]'),
  ).toHaveAttribute('sandbox', 'allow-scripts');
  expect(
    await page.locator('body').getAttribute('data-artifact-escape'),
  ).toBeNull();
  const tools = page.getByRole('region', { name: 'Review tools' });
  await tools.getByRole('button', { name: 'Interact with preview' }).click();
  await frame.getByRole('button', { name: 'Simulate retry' }).click();
  await expect(
    frame.getByRole('button', { name: 'Retry queued' }),
  ).toBeVisible();
  await tools.getByRole('button', { name: 'Pinpoint', exact: true }).click();
  await frame.locator('#queue').click();
  await expect(
    page.getByPlaceholder('Add a comment...', { exact: true }),
  ).toBeVisible();
  await frame.locator('h1').click({ modifiers: ['Shift'] });
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Specify capacity and backpressure.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Specify capacity and backpressure.', { exact: true }),
  ).toBeVisible();
  const threads = await (
    await page.request.get(`/api/artifacts/${id}/comments`)
  ).json();
  expect(threads).toHaveLength(1);
  expect(threads[0].anchor.htmlAnchor.tagName.toLowerCase()).toBe('section');
  expect(threads[0].anchor.elementContext).toBeTruthy();
  expect(threads[0].anchor.htmlAdditionalTargets).toHaveLength(1);
  const other = await browser.newContext();
  try {
    const invitation = await post(
      page.request,
      `/workspaces/${workspace.id}/invitations`,
      { role: 'viewer' },
    );
    await authenticate(other.request, '/auth/register', {
      name: 'HTML Reader',
      email: 'html-reader@example.test',
      password: credentials.password,
      invitation: invitation.token,
    });
    const reader = await other.newPage();
    await reader.goto(url);
    const readerFrame = reader.frameLocator(
      'iframe[title="HTML artifact preview"]',
    );
    await expect(readerFrame.locator('[data-plannotator-marker]')).toHaveCount(
      2,
    );
    await expect(
      reader.getByRole('button', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    await readerFrame.locator('[data-plannotator-marker]').first().click();
    await expect(
      reader.getByText('Specify capacity and backpressure.', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(frame.locator('[data-plannotator-marker]')).toHaveCount(2);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Artifact source')).toHaveValue(body);
    const updated = body.replace(
      'Queue capacity is an open decision.',
      'Queue capacity is 1000 jobs.',
    );
    await page.getByLabel('Artifact source').fill(updated);
    await page
      .getByRole('button', { name: 'Save revision', exact: true })
      .click();
    await expect(frame.getByText('Queue capacity is 1000 jobs.')).toBeVisible();
    expect(
      (await (await page.request.get(`/api/artifacts/${id}`)).json()).revision
        .body,
    ).toBe(updated);
    await page
      .getByRole('button', { name: 'Review changes', exact: true })
      .click();
    await expect(page.locator('.revision-diff')).toContainText(
      'Source changes',
    );
    await expect(page.locator('.revision-diff')).toContainText(
      '<!doctype html>',
    );
    expect(
      await page.locator('body').getAttribute('data-artifact-escape'),
    ).toBeNull();
    await page
      .getByRole('button', { name: 'Back to artifact', exact: true })
      .click();
    await expect(
      page.getByText('Specify capacity and backpressure.', { exact: true }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});

test('standalone diagrams use upstream renderers and config source survives editing', async ({
  page,
}) => {
  test.setTimeout(150000);
  const workspace = await setup(page, 'Diagram and config review');
  for (const [path, body, kind] of [
    ['retry.mmd', 'flowchart LR\nAPI --> Queue\nQueue --> Worker\n', 'mermaid'],
    [
      'retry.dot',
      'digraph Retry { API -> Queue; Queue -> Worker; }',
      'graphviz',
    ],
  ]) {
    const artifact = await post(page.request, '/artifacts', {
      workspaceId: workspace.id,
      path,
      body,
    });
    await page.goto(`/?workspace=${workspace.id}&artifact=${artifact.id}`);
    const diagram = page.locator(`[data-diagram-block="${kind}"]`);
    await expect(diagram.locator('svg').first()).toBeVisible({
      timeout: 45000,
    });
    await diagram.locator('g.node').filter({ hasText: 'Queue' }).click();
    const composer = page.locator('[data-diagram-composer]');
    await composer
      .getByPlaceholder('Add a comment...')
      .fill(`Bound the ${kind} queue.`);
    await composer
      .getByRole('button', { name: 'Comment', exact: true })
      .click();
    await expect(
      page.getByText(`Bound the ${kind} queue.`, { exact: true }),
    ).toBeVisible();
    const comments = await (
      await page.request.get(`/api/artifacts/${artifact.id}/comments`)
    ).json();
    expect(comments[0].anchor.diagramAnchor.sourceLine[0]).toBe(
      kind === 'mermaid' ? 2 : 1,
    );
    await page.reload();
    await expect(
      page.getByText(`Bound the ${kind} queue.`, { exact: true }),
    ).toBeVisible();
    await diagram.getByRole('button', { name: 'Expand diagram' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Artifact source')).toHaveValue(body);
    await page
      .getByRole('button', { name: 'Discard draft', exact: true })
      .click();
  }
  const body = '---\napiVersion: apps/v1\nkind: Deployment\n---\nreplicas: 3\n';
  const artifact = await post(page.request, '/artifacts', {
    workspaceId: workspace.id,
    path: 'deployment.yaml',
    body,
  });
  await page.goto(`/?workspace=${workspace.id}&artifact=${artifact.id}`);
  await expect(page.locator('.artifact-surface')).toContainText(
    'apiVersion: apps/v1',
  );
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Artifact source')).toHaveValue(body);
  await page.getByLabel('Artifact source').fill(body.replace('3', '4'));
  await page
    .getByRole('button', { name: 'Save revision', exact: true })
    .click();
  await expect(page.locator('.artifact-surface')).toContainText('replicas: 4');
  const xml = '<deployment replicas="4"><queue capacity="1000" /></deployment>';
  const config = await post(page.request, '/artifacts', {
    workspaceId: workspace.id,
    path: 'deployment.xml',
    body: xml,
  });
  await page.goto(`/?workspace=${workspace.id}&artifact=${config.id}`);
  await expect(page.locator('.artifact-surface')).toContainText(xml);
  const configTools = page.locator('[data-viewer-annotation-controls]');
  await configTools.getByRole('button', { name: 'Select', exact: true }).click();
  await configTools.getByRole('button', { name: 'Comment', exact: true }).click();
  await page
    .locator('.artifact-surface')
    .getByText(xml, { exact: true })
    .click({ clickCount: 3 });
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Explain the capacity limit.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await expect(
    page.locator('.artifact-surface .annotation-highlight'),
  ).toContainText(xml);
});

test('dark viewer selection has readable foreground and background colors', async ({
  page,
}) => {
  const workspace = await setup(page, 'Selection contrast');
  const artifact = await post(page.request, '/artifacts', {
    workspaceId: workspace.id,
    path: 'capacity.md',
    body: '# Capacity\n\nQueue capacity needs review.\n',
  });
  await page.goto(`/?workspace=${workspace.id}&artifact=${artifact.id}`);
  await appearance(page, 'Dark');
  const tools = page.locator('[data-viewer-annotation-controls]');
  await tools.getByRole('button', { name: 'Select', exact: true }).click();
  await page
    .locator('.artifact-surface')
    .getByText('Queue capacity needs review.', { exact: true })
    .click({ clickCount: 3 });
  const mark = page.locator('.artifact-surface .annotation-highlight').first();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveCSS('color', 'rgb(20, 27, 48)');
  await expect(mark).toHaveCSS('background-color', 'rgb(185, 200, 255)');
  const selection = await mark.evaluate((el) => ({
    color: getComputedStyle(el, '::selection').color,
    background: getComputedStyle(el, '::selection').backgroundColor,
  }));
  expect(selection).toEqual({
    color: 'rgb(20, 27, 48)',
    background: 'rgb(185, 200, 255)',
  });
});
