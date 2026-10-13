import { authenticate } from './controls';
import { openSettings, startDiscussion } from './controls';
import { choose } from './controls';
import { test, expect, type APIRequestContext } from '@playwright/test';

const origin = 'http://127.0.0.1:4411';
const password = 'browser-test-password-1234';
async function send(request: APIRequestContext, path: string, data: unknown) {
  const response = path.startsWith('/auth/') ? await authenticate(request, path, data) : await request.post(`/api${path}`, {
    headers: { Origin: origin },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test('administrators manage teams, ownership and offboarding while teammates retain review history', async ({
  page,
  browser,
}) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const status = await (await page.request.get('/api/auth/status')).json();
  await send(page.request, status.needsSetup ? '/auth/setup' : '/auth/login', {
    name: 'Alex Morgan',
    email: 'alex@example.test',
    password,
  });
  const home = (await (await page.request.get('/api/workspaces')).json())[0];
  const invite = await send(
    page.request,
    `/workspaces/${home.id}/invitations`,
    { role: 'viewer' },
  );
  const other = await browser.newContext();
  try {
    const teammate = await other.newPage();
    teammate.on('pageerror', (e) => errors.push(e.message));
    const { user } = await send(other.request, '/auth/register', {
      name: 'Taylor Company',
      email: 'company-browser@example.test',
      password,
      invitation: invite.token,
    });
    const workspace = await send(page.request, '/workspaces', {
      name: 'Company launch',
    });
    const doc = await send(page.request, '/artifacts', {
      workspaceId: workspace.id,
      path: 'launch.md',
      body: '# Company launch\n\nPreserve our decisions.',
    });
    const url = `/?workspace=${workspace.id}&artifact=${doc.id}`;
    await page.goto(url);
    await teammate.goto('/');
    await expect(
      teammate.getByRole('button', { name: 'Organization', exact: true }),
    ).toHaveCount(0);
    await openSettings(page, 'Organization');
    await page.getByLabel('Organization name').fill('Example Company');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(
      page.getByText('Example Company', { exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Teams', exact: true }).click();
    await page
      .getByRole('button', { name: 'Create team', exact: true })
      .click();
    await page.getByLabel('Team name', { exact: true }).fill('Launch team');
    await page
      .getByRole('checkbox', {
        name: 'Taylor Company · company-browser@example.test',
      })
      .check();
    await choose(
      page.getByLabel('Team access to Company launch', { exact: true }),
      'Editor',
    );
    await page.getByRole('button', { name: 'Save team', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Edit Launch team', exact: true }),
    ).toBeVisible();
    await teammate.goto(url);
    await expect(
      teammate.getByRole('heading', { name: 'Company launch', exact: true }),
    ).toBeVisible();
    await startDiscussion(teammate);
    await teammate
      .getByLabel('Artifact discussion')
      .fill('Keep this discussion after I leave.');
    await teammate.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(
      teammate.getByText('Keep this discussion after I leave.'),
    ).toBeVisible();
    await openSettings(teammate, 'Members');
    await expect(
      teammate.getByText('Via Launch team', { exact: true }),
    ).toBeVisible();
    await teammate.getByRole('button', { name: '← Back to workspace' }).click();
    await openSettings(teammate, 'Agent access');
    await teammate.getByLabel('Agent name').fill('Launch helper');
    await teammate
      .getByRole('button', { name: 'Create agent key', exact: true })
      .click();
    const key = await teammate
      .getByLabel('Agent key', { exact: true })
      .inputValue();
    await teammate.getByRole('button', { name: '← Back to workspace' }).click();
    // Another person created credentials: refresh before making a new administrative decision.
    await page
      .getByRole('button', { name: 'Refresh settings', exact: true })
      .click();
    await page.getByRole('tab', { name: 'Workspaces', exact: true }).click();
    await choose(
      page.getByLabel('Manage workspace', { exact: true }),
      'Company launch',
    );
    await choose(
      page.getByLabel('Direct role for Taylor Company', { exact: true }),
      'Viewer',
    );
    await page
      .locator('form')
      .filter({
        has: page.getByLabel('Direct role for Taylor Company', { exact: true }),
      })
      .getByRole('button', { name: 'Save role', exact: true })
      .click();
    await expect(
      page.getByText('Via Launch team (editor)', { exact: true }),
    ).toBeVisible();
    await choose(
      page.getByLabel('New owner', { exact: true }),
      'Taylor Company',
    );
    await page
      .getByRole('button', { name: 'Transfer ownership', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Confirm action' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    await expect(
      page.getByLabel('Direct role for Taylor Company', { exact: true }),
    ).toHaveText('Owner');
    await expect(
      page.getByLabel('Direct role for Alex Morgan', { exact: true }),
    ).toHaveText('Editor');
    await page.getByRole('tab', { name: 'People', exact: true }).click();
    await page
      .getByRole('button', { name: 'Offboard Taylor Company', exact: true })
      .click();
    await expect(
      page.getByText('Solely owned workspaces: Company launch.'),
    ).toBeVisible();
    const ownerId = (await (await page.request.get('/api/auth/status')).json())
      .user.id;
    await choose(
      page.getByLabel('Successor for owned workspaces', { exact: true }),
      'Alex Morgan',
    );
    await page
      .getByRole('button', { name: 'Confirm offboarding', exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Confirm action' })
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Reactivate account', exact: true }),
    ).toBeVisible();
    const denied = await other.request.get('/api/workspaces');
    expect(denied.status()).toBe(401);
    const revoked = await page.request.get('/api/workspaces', {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(revoked.status()).toBe(401);
    await teammate.reload();
    await expect(
      teammate.getByRole('button', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Audit log', exact: true }).click();
    await expect(
      page.getByText('account · offboarded', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('workspace · ownership transferred', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '← Back to workspace' }).click();
    await page.reload();
    await expect(
      page.getByText('Keep this discussion after I leave.'),
    ).toBeVisible();
    await openSettings(page, 'Organization');
    await page.getByRole('tab', { name: 'Teams', exact: true }).click();
    await page
      .getByRole('button', { name: 'Edit Launch team', exact: true })
      .click();
    await expect(
      page.getByRole('checkbox', {
        name: 'Taylor Company · company-browser@example.test',
      }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Team name', { exact: true })).toBeVisible();
    expect(
      await page
        .getByRole('region', { name: 'Organization', exact: true })
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: '/tmp/company-administration-mobile.png',
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await other.close();
  }
});
