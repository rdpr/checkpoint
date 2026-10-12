import { openSettings, manageArtifact } from './controls';
import { choose } from './controls';
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
  await send(page.request, `/workspaces/${first.id}/folders`, {
    name: 'decisions',
  });
  const second = await send(page.request, '/workspaces', {
    name: 'Daily research',
  });
  const doc = await send(page.request, '/artifacts', {
    workspaceId: first.id,
    path: 'plans/launch.md',
    body: '# Launch\n\nThe quetzal launch is ready for review.',
  });
  const otherDoc = await send(page.request, '/artifacts', {
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
      await send(peer.request, `/artifacts/${d.id}/review-requests`, {
        expectedRevisionId: d.currentRevisionId,
        reviewerId: user.id,
        message: 'Check this daily plan',
      });
    const comment = await send(page.request, `/artifacts/${doc.id}/comments`, {
      revisionId: doc.currentRevisionId,
      body: 'Please check the schedule',
    });
    await send(peer.request, `/comments/${comment.id}/replies`, {
      body: 'The dates work for the team',
    });
    await page.goto(`/?workspace=${first.id}`);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByRole('dialog', { name: 'Search artifacts' });
    await search.getByLabel('Search saved content and paths').fill('quetzal');
    await expect(search.locator('.search-result')).toHaveCount(2);
    await choose(
      search.getByLabel('Workspace', { exact: true }),
      'Daily research',
    );
    await expect(search.locator('.search-result')).toHaveCount(1);
    await search.getByRole('button', { name: /Research/ }).click();
    await expect(page).toHaveURL(new RegExp(`artifact=${otherDoc.id}`));
    await page.getByRole('button', { name: 'My reviews', exact: true }).click();
    const queue = page.locator('.review-queue');
    await expect(
      queue.getByRole('button', {
        name: 'Open requested revision of plans/launch.md',
      }),
    ).toBeVisible();
    await expect(
      queue.getByRole('button', {
        name: 'Open requested revision of research.md',
      }),
    ).toBeVisible();
    await choose(queue.getByLabel('Filter workspace'), 'Daily planning');
    await expect(queue.locator('.request-row')).toHaveCount(1);
    await queue
      .getByRole('button', {
        name: 'Open requested revision of plans/launch.md',
      })
      .click();
    await manageArtifact(page);
    const management = page.getByRole('dialog', { name: 'Manage artifact' });
    await management.getByLabel('Artifact name').fill('release');
    await choose(management.getByLabel('Folder', { exact: true }), 'decisions');
    await management.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.breadcrumb')).toContainText('decisions');
    await manageArtifact(page);
    await management
      .getByRole('button', { name: 'Archive artifact', exact: true })
      .click();
    await expect(page.locator('.archive-banner')).toContainText('read-only');
    await expect(
      page.getByRole('button', { name: 'Edit', exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'All artifacts', exact: false })
      .click();
    await expect(
      page
        .getByRole('navigation', { name: 'Workspace artifacts' })
        .getByRole('button', { name: /release.md/ }),
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Artifact navigation options', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Show archived artifacts', exact: true })
      .click();
    await page
      .getByRole('navigation', { name: 'Workspace artifacts' })
      .getByRole('button', { name: /release.md/ })
      .click();
    await manageArtifact(page);
    await management
      .getByRole('button', { name: 'Unarchive artifact', exact: true })
      .click();
    await expect(page.locator('.archive-banner')).toHaveCount(0);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const notifications = page.getByRole('region', {
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
    await notifications
      .getByRole('button', { name: '← Back to workspace' })
      .click();
    await openSettings(page, 'Agent access');
    const access = page.getByRole('region', { name: 'Connect your agent' });
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
    await choose(
      access.getByLabel('Maximum access'),
      'Read, edit, and comment',
    );
    await access
      .getByRole('button', { name: 'Create service account', exact: true })
      .click();
    const account = access.getByRole('region', {
      name: 'Service account Company pipeline',
    });
    await account.getByLabel('Service key name').fill('Pipeline runner');
    await choose(account.getByLabel('Key access'), 'Read, edit, and comment');
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
    await access.getByRole('button', { name: '← Back to workspace' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('button', { name: 'Search artifacts', exact: true })
      .click();
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
