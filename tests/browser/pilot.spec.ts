import { startDiscussion } from './controls';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
const credentials = {
  name: 'Alex Morgan',
  email: 'alex@example.test',
  password: 'browser-test-password-1234',
};
const origin = 'http://127.0.0.1:4411';
async function send(
  request: APIRequestContext,
  path: string,
  data: unknown,
  method = 'POST',
) {
  const r = await request.fetch('/api' + path, {
    method,
    headers: { Origin: origin },
    data,
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function setup(
  request: APIRequestContext,
  name: string,
  body = '# Pilot\n\nKeep this passage attached.',
) {
  const status = await (await request.get('/api/auth/status')).json();
  const { user } = await send(
    request,
    status.needsSetup ? '/auth/setup' : '/auth/login',
    credentials,
  );
  const workspace = await send(request, '/workspaces', { name });
  const doc = await send(request, '/artifacts', {
    workspaceId: workspace.id,
    path: 'plans/pilot.md',
    body,
  });
  return {
    user,
    workspace,
    doc,
    url: `/?workspace=${workspace.id}&artifact=${doc.id}`,
  };
}
async function openComposer(page: Page) {
  const tools = page.locator('[data-viewer-annotation-controls]');
  await tools.getByRole('button', { name: 'Pinpoint', exact: true }).click();
  await tools.getByRole('button', { name: 'Markup', exact: true }).click();
  await page
    .locator('.artifact-surface')
    .getByText('Keep this passage attached.', { exact: true })
    .click();
  await page
    .locator('[data-pn-annotation-toolbar-row]')
    .getByRole('button', { name: 'Comment', exact: true })
    .click();
  return page.getByPlaceholder('Add a comment...', { exact: true });
}
test('drafts survive closed tabs, offline saves and expired sessions without crossing accounts', async ({
  page,
  context,
}) => {
  test.setTimeout(150000);
  const { doc, url } = await setup(page.request, 'Pilot recovery');
  await page.goto(url);
  const composer = await openComposer(page);
  await composer.fill('A selection draft that survives closing the tab.');
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'pilot.png',
    mimeType: 'image/png',
    buffer: await page.locator('.artifact-surface').screenshot(),
  });
  await page.getByTitle('Save (Esc)', { exact: true }).click();
  await expect(page.locator('[data-comment-popover] img')).toBeVisible();
  const next = await context.newPage();
  await page.close();
  await next.goto(url);
  await expect(await openComposer(next)).toHaveValue(
    'A selection draft that survives closing the tab.',
  );
  await expect(next.locator('[data-comment-popover] img')).toBeVisible();
  await next
    .getByPlaceholder('Add a comment...', { exact: true })
    .press('Control+Enter');
  const card = next
    .locator('.comment-card')
    .filter({ hasText: 'A selection draft' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Reply', exact: true }).click();
  await card.getByPlaceholder('Write a reply…').fill('Durable reply');
  await startDiscussion(next);
  await next
    .getByLabel('Artifact discussion', { exact: true })
    .fill('Durable discussion');
  const alternate = await context.newPage();
  await alternate.goto(url);
  await startDiscussion(alternate);
  await expect(
    alternate.getByLabel('Artifact discussion', { exact: true }),
  ).toHaveValue('Durable discussion');
  await alternate
    .getByRole('dialog', { name: 'New discussion', exact: true })
    .getByRole('button', { name: 'Close dialog' })
    .click();
  await startDiscussion(alternate);
  await alternate
    .getByLabel('Artifact discussion', { exact: true })
    .fill('Independent tab draft');
  await next.reload();
  await next.getByRole('button', { name: 'Saved drafts', exact: true }).click();
  const drafts = next.getByRole('region', { name: 'Saved drafts' });
  await expect(
    drafts.getByText('Durable discussion', { exact: true }),
  ).toBeVisible();
  await expect(
    drafts.getByText('Independent tab draft', { exact: true }),
  ).toBeVisible();
  await drafts
    .locator('article')
    .filter({ hasText: 'Durable discussion' })
    .getByRole('button', { name: 'Resume draft' })
    .click();
  await startDiscussion(next);
  await expect(
    next.getByLabel('Artifact discussion', { exact: true }),
  ).toHaveValue('Durable discussion');
  await next
    .getByRole('dialog', { name: 'New discussion', exact: true })
    .getByRole('button', { name: 'Close dialog' })
    .click();
  await next.reload();
  await startDiscussion(next);
  await expect(
    next.getByLabel('Artifact discussion', { exact: true }),
  ).toHaveValue('Durable discussion');
  await next
    .getByRole('dialog', { name: 'New discussion', exact: true })
    .getByRole('button', { name: 'Close dialog' })
    .click();
  await expect(next.getByPlaceholder('Write a reply…')).toHaveValue(
    'Durable reply',
  );
  await next.getByRole('button', { name: 'Edit', exact: true }).click();
  await next
    .locator('.cm-content[contenteditable="true"]')
    .fill('# Pilot\n\nA durable artifact edit.');
  await context.setOffline(true);
  await next
    .getByRole('button', { name: 'Save revision', exact: true })
    .click();
  await expect(next.getByRole('status')).toContainText(
    'Connection unavailable',
  );
  await context.setOffline(false);
  await send(next.request, '/auth/logout', {});
  await next
    .getByRole('button', { name: 'Save revision', exact: true })
    .click();
  await expect(next.getByText(/Your session ended/)).toBeVisible();
  await next
    .getByLabel('Email address', { exact: true })
    .fill(credentials.email);
  await next.getByLabel('Password', { exact: true }).fill(credentials.password);
  await next.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(next).toHaveURL(new RegExp(`artifact=${doc.id}`));
  await expect(
    next.locator('.cm-content[contenteditable="true"]'),
  ).toContainText('A durable artifact edit.');
  const before = await (
    await next.request.get(`/api/artifacts/${doc.id}`)
  ).json();
  expect(before.currentRevisionId).toBe(doc.currentRevisionId);
  await next
    .getByRole('button', { name: 'Save revision', exact: true })
    .click();
  await expect(next.locator('.artifact-surface')).toContainText(
    'A durable artifact edit.',
  );
  await alternate.close();
  await next.close();
});

test('moved Markdown links, browser history and outcome notifications retain artifact and review identity', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const { doc, workspace, url, user } = await setup(
    page.request,
    'Pilot navigation',
    '# Source\n\n[Open target](target.md#details)',
  );
  const target = await send(page.request, '/artifacts', {
    workspaceId: workspace.id,
    path: 'plans/target.md',
    body: '# Target\n\n## Details\n\nThe destination.',
  });
  for (const [d, path] of [
    [doc, 'moved/source.md'],
    [target, 'moved/destination.md'],
  ] as const)
    await send(
      page.request,
      `/artifacts/${d.id}`,
      {
        path,
        expectedRevisionId: d.currentRevisionId,
        expectedMetadataVersion: d.metadataVersion,
      },
      'PATCH',
    );
  const reserved = await page.request.post('/api/artifacts', {
    headers: { Origin: origin },
    data: {
      workspaceId: workspace.id,
      path: 'plans/target.md',
      body: '# Wrong',
    },
  });
  expect(reserved.status()).toBe(409);
  await page.goto(url);
  const link = page.getByRole('link', { name: 'Open target' });
  await expect(link).toHaveAttribute(
    'href',
    new RegExp(`artifact=${target.id}.*heading=details`),
  );
  const [linkedTab] = await Promise.all([
    page.context().waitForEvent('page'),
    link.click({ modifiers: ['Control'] }),
  ]);
  await expect(
    linkedTab
      .locator('.artifact-surface')
      .getByRole('heading', { name: 'Target', exact: true }),
  ).toBeVisible();
  await linkedTab.close();
  await link.click();
  await expect(page).toHaveURL(
    new RegExp(`artifact=${target.id}.*heading=details`),
  );
  await expect(
    page
      .locator('.artifact-surface')
      .getByRole('heading', { name: 'Target', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page
      .locator('.artifact-surface')
      .getByRole('heading', { name: 'Source', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(
    page
      .locator('.artifact-surface')
      .getByRole('heading', { name: 'Target', exact: true }),
  ).toBeVisible();
  const peer = await browser.newContext();
  try {
    const invite = await send(
      page.request,
      `/workspaces/${workspace.id}/invitations`,
      { role: 'editor' },
    );
    const { user: reviewer } = await send(peer.request, '/auth/register', {
      name: 'Pilot Reviewer',
      email: 'pilot-reviewer@example.test',
      password: credentials.password,
      invitation: invite.token,
    });
    const round = await send(
      page.request,
      `/artifacts/${target.id}/review-requests`,
      {
        reviewerId: reviewer.id,
        expectedRevisionId: target.currentRevisionId,
        message: 'Pilot approval',
      },
    );
    const reviewerPage = await peer.newPage();
    await reviewerPage.goto(
      `/?workspace=${workspace.id}&artifact=${target.id}&request=${round.id}`,
    );
    await reviewerPage
      .getByRole('button', { name: 'Finish review', exact: true })
      .click();
    await reviewerPage
      .getByLabel('Review note (optional)')
      .fill('Ready for the pilot.');
    await reviewerPage
      .getByRole('button', { name: 'Approve', exact: true })
      .click();
    await expect(
      reviewerPage.getByRole('region', {
        name: 'Artifact review',
        exact: true,
      }),
    ).toContainText('Approved');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const notifications = page.getByRole('region', { name: 'Notifications' });
    await expect(notifications).toContainText('Ready for the pilot.');
    await notifications
      .locator('button.search-result')
      .filter({ hasText: 'Ready for the pilot.' })
      .click();
    await expect(page).toHaveURL(new RegExp(`request=${round.id}`));
    await expect(
      page.getByRole('region', { name: 'Artifact review', exact: true }),
    ).toContainText('Approved');
    // A different account in this browser must not commit a stale tab's write.
    await send(page.request, '/auth/login', {
      email: 'pilot-reviewer@example.test',
      password: credentials.password,
    });
    const denied = await page.request.put(`/api/artifacts/${target.id}`, {
      headers: { Origin: origin, 'X-Workspace-User': user.id },
      data: {
        expectedRevisionId: target.currentRevisionId,
        body: '# Wrong account',
      },
    });
    expect(denied.status()).toBe(401);
    expect((await denied.json()).code).toBe('session_changed');
  } finally {
    await peer.close();
  }
});
