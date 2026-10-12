import { test, expect, type APIRequestContext } from '@playwright/test';

test.use({ actionTimeout: 15000 });

test('people discover content across workspaces, manage its lifecycle, receive replies and connect unattended agents', async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  const origin = 'http://127.0.0.1:4411';
  const password = 'browser-test-password-1234';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const send = async (
    request: APIRequestContext,
    path: string,
    data: unknown,
  ) => {
    const r = await request.post('/api' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const status = await (await page.request.get('/api/auth/status')).json();
  const { user } = await send(
    page.request,
    status.needsSetup ? '/auth/setup' : '/auth/login',
    { name: 'Alex Morgan', email: 'alex@example.test', password },
  );
  const first = await send(page.request, '/workspaces', {
    name: 'Daily planning',
  });
  const second = await send(page.request, '/workspaces', {
    name: 'Daily research',
  });
  const doc = await send(page.request, '/documents', {
    workspaceId: first.id,
    path: 'plans/launch.md',
    body: '# Launch\n\nThe quetzal launch is ready for review.',
  });
  const otherDoc = await send(page.request, '/documents', {
    workspaceId: second.id,
    path: 'research.md',
    body: '# Research\n\nQuetzal research findings.',
  });
  const peer = await browser.newContext();
  try {
    const invite = await send(
      page.request,
      `/workspaces/${first.id}/invitations`,
      { role: 'editor' },
    );
    await send(peer.request, '/auth/register', {
      name: 'Daily reviewer',
      email: 'daily@example.test',
      password,
      invitation: invite.token,
    });
    const invite2 = await send(
      page.request,
      `/workspaces/${second.id}/invitations`,
      { role: 'editor' },
    );
    await send(peer.request, '/invitations/accept', { token: invite2.token });
    for (const d of [doc, otherDoc])
      await send(peer.request, `/documents/${d.id}/review-requests`, {
        expectedRevisionId: d.currentRevisionId,
        reviewerId: user.id,
        message: 'Check this daily plan',
      });
    const comment = await send(page.request, `/documents/${doc.id}/comments`, {
      revisionId: doc.currentRevisionId,
      body: 'Please check the schedule',
    });
    await send(peer.request, `/comments/${comment.id}/replies`, {
      body: 'The dates work for the team',
    });
    await page.goto(`/?workspace=${first.id}`);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByRole('dialog', { name: 'Search documents' });
    await search.getByLabel('Search saved content and paths').fill('quetzal');
    await expect(search.locator('.search-result')).toHaveCount(2);
    await search
      .getByLabel('Workspace', { exact: true })
      .selectOption(second.id);
    await expect(search.locator('.search-result')).toHaveCount(1);
    await search.getByRole('button', { name: /research.md/ }).click();
    await expect(page).toHaveURL(new RegExp(`document=${otherDoc.id}`));
    await page.getByRole('button', { name: 'My reviews', exact: true }).click();
    const queue = page.locator('.review-queue');
    await expect(
      queue.getByText('Daily planning / plans/launch.md'),
    ).toBeVisible();
    await expect(queue.getByText('Daily research / research.md')).toBeVisible();
    await queue.getByLabel('Filter workspace').selectOption(first.id);
    await expect(queue.locator('.request-card')).toHaveCount(1);
    await queue
      .getByRole('button', { name: 'Open requested revision' })
      .click();
    await page
      .getByRole('button', { name: 'Manage document', exact: true })
      .click();
    const management = page.getByRole('dialog', { name: 'Manage document' });
    await management.getByLabel('Document path').fill('decisions/release.md');
    await management.getByRole('button', { name: 'Save path' }).click();
    await expect(page.locator('.breadcrumb')).toContainText(
      'decisions/release.md',
    );
    await page
      .getByRole('button', { name: 'Manage document', exact: true })
      .click();
    await management
      .getByRole('button', { name: 'Archive document', exact: true })
      .click();
    await expect(page.locator('.archive-banner')).toContainText('read-only');
    await expect(
      page.getByRole('button', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'All documents', exact: false })
      .click();
    await expect(
      page
        .getByRole('navigation', { name: 'Workspace documents' })
        .getByRole('button', { name: /release.md/ }),
    ).toHaveCount(0);
    await page.getByLabel('Show archived').check();
    await page
      .getByRole('navigation', { name: 'Workspace documents' })
      .getByRole('button', { name: /release.md/ })
      .click();
    await page
      .getByRole('button', { name: 'Manage document', exact: true })
      .click();
    await management
      .getByRole('button', { name: 'Unarchive document', exact: true })
      .click();
    await expect(page.locator('.archive-banner')).toHaveCount(0);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const notifications = page.getByRole('dialog', {
      name: 'Notifications',
      exact: true,
    });
    await expect(notifications).toContainText('The dates work for the team');
    await notifications
      .getByRole('button', { name: /The dates work for the team/ })
      .click();
    await expect(page.locator('.comment-card.selected')).toContainText(
      'The dates work for the team',
    );
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await notifications
      .getByRole('button', { name: 'Mark all as read' })
      .click();
    await expect(notifications.locator('.unread')).toHaveCount(0);
    await notifications.getByRole('button', { name: 'Close dialog' }).click();
    await page
      .getByRole('button', { name: 'Agent access', exact: true })
      .click();
    const access = page.getByRole('dialog', { name: 'Connect your agent' });
    await access
      .getByLabel('Agent name', { exact: true })
      .fill('Personal planning');
    await access
      .getByRole('button', { name: 'Create agent key', exact: true })
      .click();
    await access
      .getByRole('button', { name: 'Check connection', exact: true })
      .click();
    await expect(access.getByRole('status')).toContainText(
      'Personal account: Alex Morgan',
    );
    const config = JSON.parse(
      await access.getByLabel('MCP connection configuration').inputValue(),
    );
    expect(config.mcpServers.workspaces.url).toBe(origin + '/mcp');
    expect(config.mcpServers.workspaces.headers.Authorization).toMatch(
      /^Bearer pw_/,
    );
    await access.getByLabel('Service account name').fill('Company pipeline');
    await access.getByLabel('Maximum access').selectOption('write');
    await access
      .getByRole('button', { name: 'Create service account', exact: true })
      .click();
    const account = access.getByRole('region', {
      name: 'Service account Company pipeline',
    });
    await account.getByLabel('Service key name').fill('Pipeline runner');
    await account.getByLabel('Key access').selectOption('write');
    await account
      .getByRole('button', { name: 'Create service key', exact: true })
      .click();
    await access
      .getByRole('button', { name: 'Check connection', exact: true })
      .click();
    await expect(access.getByRole('status')).toContainText(
      'Workspace service account: Company pipeline',
    );
    await page.screenshot({
      path: 'test-results/agent-onboarding-desktop.png',
      fullPage: true,
    });
    await account
      .getByRole('button', { name: 'Disable account', exact: true })
      .click();
    await account
      .getByRole('button', { name: 'Disable and revoke keys', exact: true })
      .click();
    await expect(account).toContainText('Disabled');
    await access
      .getByRole('button', { name: 'Check connection', exact: true })
      .click();
    await expect(access.getByRole('alert')).toContainText('valid agent key');
    await access.getByRole('button', { name: 'Close dialog' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('button', { name: 'Collapse sidebar', exact: true })
      .click();
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await search.getByLabel('Search saved content and paths').fill('quetzal');
    await expect(search.locator('.search-result')).toHaveCount(2);
    await page.screenshot({
      path: 'test-results/daily-search-mobile.png',
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await peer.close();
  }
});
