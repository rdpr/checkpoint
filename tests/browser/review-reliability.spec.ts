import { test, expect, type APIRequestContext } from '@playwright/test';

const origin = 'http://127.0.0.1:4411';
const credentials = {
  name: 'Alex Morgan',
  email: 'alex@example.test',
  password: 'browser-test-password-1234',
};
async function send(
  request: APIRequestContext,
  path: string,
  data: unknown,
  method = 'POST',
) {
  const response = await request.fetch(`/api${path}`, {
    method,
    headers: { Origin: origin },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function setup(request: APIRequestContext, name: string) {
  const status = await (await request.get('/api/auth/status')).json();
  const { user } = await send(
    request,
    status.needsSetup ? '/auth/setup' : '/auth/login',
    credentials,
  );
  const workspace = await send(request, '/workspaces', { name });
  const doc = await send(request, '/documents', {
    workspaceId: workspace.id,
    path: 'plan.md',
    body: '# Reliability\n\nKeep this passage attached.',
  });
  return {
    user,
    workspace,
    doc,
    url: `/?workspace=${workspace.id}&document=${doc.id}`,
  };
}

test('failed and unconfirmed comment saves survive reload and retry once on their original revision', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const { doc, url } = await setup(page.request, 'Comment recovery');
  const other = await browser.newContext();
  try {
    await send(other.request, '/auth/login', credentials);
    await page.goto(url);
    const tools = page.getByRole('region', { name: 'Review tools' });
    await tools.getByRole('button', { name: 'Pinpoint', exact: true }).click();
    await tools.getByRole('button', { name: 'Markup', exact: true }).click();
    await page
      .locator('.document-surface')
      .getByText('Keep this passage attached.', { exact: true })
      .click();
    await page
      .locator('[data-pn-annotation-toolbar-row]')
      .getByRole('button', { name: 'Comment', exact: true })
      .click();
    const composer = page.getByPlaceholder('Add a comment...', {
      exact: true,
    });
    await composer.fill('Keep the evidence and original anchor.');
    await page
      .getByRole('button', { name: 'Attachments', exact: true })
      .click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'evidence.png',
      mimeType: 'image/png',
      buffer: await page.locator('.document-surface').screenshot(),
    });
    await page.getByTitle('Save (Esc)', { exact: true }).click();
    await expect(page.locator('[data-comment-popover] img')).toBeVisible();
    const endpoint = `**/api/documents/${doc.id}/comments`;
    // Fault injection only: all successful writes still go to the real service and SQLite.
    await page.route(endpoint, (route) =>
      route.request().method() === 'POST'
        ? route.abort('failed')
        : route.continue(),
    );
    await composer.press('Control+Enter');
    const recovery = page.getByRole('region', { name: 'Unsaved comments' });
    await expect(recovery).toContainText(
      'Keep the evidence and original anchor.',
    );
    await expect(
      recovery.getByRole('button', { name: 'Retry comment save' }),
    ).toBeEnabled();
    await page.reload();
    await expect(recovery).toContainText('Keep this passage attached.');
    await expect(recovery.getByRole('img')).toBeVisible();
    await page.screenshot({
      path: 'test-results/comment-recovery.png',
      fullPage: true,
    });
    await send(
      other.request,
      `/documents/${doc.id}`,
      {
        expectedRevisionId: doc.currentRevisionId,
        body: '# Reliability\n\nA different passage now.',
      },
      'PUT',
    );
    await expect(page.locator('.document-surface')).toContainText(
      'A different passage now.',
      { timeout: 12000 },
    );
    await page.unroute(endpoint);
    // Server commits the comment but the browser never receives its response.
    await page.route(endpoint, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('failed');
    });
    await recovery.getByRole('button', { name: 'Retry comment save' }).click();
    await expect(
      recovery.getByRole('button', { name: 'Retry comment save' }),
    ).toBeEnabled();
    await page.reload();
    await expect(recovery).toContainText('Revision 1');
    await page.unroute(endpoint);
    await recovery.getByRole('button', { name: 'Retry comment save' }).click();
    await expect(recovery).toHaveCount(0);
    const comments = await (
      await page.request.get(`/api/documents/${doc.id}/comments`)
    ).json();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      revisionId: doc.currentRevisionId,
      quote: 'Keep this passage attached.',
      body: 'Keep the evidence and original anchor.',
    });
    expect(comments[0].images).toHaveLength(1);
    expect(comments[0].anchor.blockId).toBeTruthy();
    await page.reload();
    await expect(page.locator('.comment-card')).toContainText(
      'Keep the evidence and original anchor.',
    );
    await expect(recovery).toHaveCount(0);

    // Comparison feedback must also retain its frozen base/target when recovered.
    await page
      .getByRole('button', { name: 'Review changes', exact: true })
      .click();
    await tools.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    await page
      .locator('.plan-diff-removed')
      .filter({ hasText: 'Keep this passage attached.' })
      .click();
    await composer.fill('Why remove this passage?');
    await page.route(endpoint, (route) =>
      route.request().method() === 'POST'
        ? route.abort('failed')
        : route.continue(),
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(recovery).toContainText('comparison comment');
    await expect(
      recovery.getByRole('button', { name: 'Retry comment save' }),
    ).toBeEnabled();
    await page.reload();
    await page.unroute(endpoint);
    await recovery.getByRole('button', { name: 'Retry comment save' }).click();
    await expect(recovery).toHaveCount(0);
    const final = await (
      await page.request.get(`/api/documents/${doc.id}/comments`)
    ).json();
    expect(final).toHaveLength(2);
    expect(
      final.find((c: { body: string }) => c.body === 'Why remove this passage?')
        .diff,
    ).toMatchObject({
      baseRevisionId: doc.currentRevisionId,
      side: 'removed',
    });
  } finally {
    await other.close();
  }
});

test('review notes survive navigation and stale revisions, and a repeat round requires a fresh response', async ({
  page,
  browser,
}) => {
  const { user, workspace, doc, url } = await setup(
    page.request,
    'Decision recovery',
  );
  const other = await browser.newContext();
  try {
    await send(other.request, '/auth/login', credentials);
    await page.goto(url);
    await page
      .getByRole('button', { name: 'Review this revision', exact: true })
      .click();
    await page
      .getByLabel('Review note (optional)')
      .fill('Retain this decision note.');
    await page.getByRole('button', { name: 'My reviews', exact: true }).click();
    await page.goto(url);
    await expect(page.getByLabel('Review note (optional)')).toHaveValue(
      'Retain this decision note.',
    );
    await page.reload();
    await expect(page.getByLabel('Review note (optional)')).toHaveValue(
      'Retain this decision note.',
    );
    const next = await send(
      other.request,
      `/documents/${doc.id}`,
      {
        expectedRevisionId: doc.currentRevisionId,
        body: doc.revision.body + '\n\nInspect the new changes.',
      },
      'PUT',
    );
    await expect(
      page.getByRole('button', { name: 'Approve', exact: true }),
    ).toBeDisabled({ timeout: 12000 });
    await page.reload();
    await expect(page.getByLabel('Review note (optional)')).toHaveValue(
      'Retain this decision note.',
    );
    await page
      .getByRole('button', { name: 'Use note for revision 2', exact: true })
      .click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const review = page.getByRole('region', {
      name: 'Document review',
      exact: true,
    });
    await expect(review).toContainText('Approved');
    await expect(page.getByLabel('Review note (optional)')).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Review note (optional)')).toHaveCount(0);
    const round = await send(
      other.request,
      `/documents/${doc.id}/review-requests`,
      {
        expectedRevisionId: next.currentRevisionId,
        reviewerId: user.id,
        message: 'Please verify again.',
      },
    );
    await page.goto(`${url}&request=${round.id}`);
    await expect(review).toContainText(
      'This review round is waiting for your response. Earlier decisions do not complete this round.',
    );
    await page
      .getByRole('button', { name: 'Respond to this round', exact: true })
      .click();
    await page
      .getByLabel('Review note (optional)')
      .fill('Checked again for this round.');
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(review).toContainText(
      'This round is complete: Alex Morgan approved.',
    );
    await page.goto(`/?workspace=${workspace.id}&view=reviews`);
    await page.getByLabel('Filter workspace').selectOption(workspace.id);
    await expect(page.getByText('No reviews waiting on you.')).toBeVisible();
    const saved = await (
      await page.request.get(`/api/review-requests/${round.id}`)
    ).json();
    expect(saved.status).toBe('approved');
    expect(saved.decision.note).toBe('Checked again for this round.');
    // Finishing a save from an unmounted form must not erase a newer draft.
    await page.goto(url);
    await page
      .getByRole('button', { name: 'Update your review', exact: true })
      .click();
    await page
      .getByLabel('Review note (optional)')
      .fill('A slow confirmation.');
    let release!: () => void;
    const responseHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    let committed!: () => void;
    const serverSaved = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const reviewEndpoint = `**/api/documents/${doc.id}/reviews`;
    await page.route(reviewEndpoint, async (route) => {
      const response = await route.fetch();
      committed();
      await responseHeld;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await serverSaved;
    await page.getByRole('button', { name: 'My reviews', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Workspace documents' })
      .getByRole('button', { name: 'plan.md', exact: true })
      .click();
    await page
      .getByLabel('Review note (optional)')
      .fill('New work after navigating back.');
    const finished = page.waitForResponse((response) =>
      response.url().endsWith(`/documents/${doc.id}/reviews`),
    );
    release();
    await finished;
    await page.unroute(reviewEndpoint);
    await page.reload();
    await expect(page.getByLabel('Review note (optional)')).toHaveValue(
      'New work after navigating back.',
    );
    await page
      .getByRole('button', { name: 'Discard review draft', exact: true })
      .click();
    await page.reload();
    await expect(page.getByLabel('Review note (optional)')).toHaveCount(0);
  } finally {
    await other.close();
  }
});
