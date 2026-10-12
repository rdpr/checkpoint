import { test, expect } from '@playwright/test';
import { choose, manageArtifact } from './controls';

test('people organize artifacts with persistent folders and keep old links working', async ({
  page,
}) => {
  const origin = 'http://127.0.0.1:4411';
  const status = await (await page.request.get('/api/auth/status')).json();
  const auth = await page.request.post(
    `/api/auth/${status.needsSetup ? 'setup' : 'login'}`,
    {
      headers: { Origin: origin },
      data: {
        name: 'Alex Morgan',
        email: 'alex@example.test',
        password: 'browser-test-password-1234',
      },
    },
  );
  expect(auth.ok(), await auth.text()).toBeTruthy();
  const workspace = await (
    await page.request.post('/api/workspaces', {
      headers: { Origin: origin },
      data: { name: 'Artifact organization' },
    })
  ).json();
  await page.goto(`/?workspace=${workspace.id}`);
  await expect(page.getByPlaceholder('Find a document…')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Create artifact or folder', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'New folder', exact: true })
    .last()
    .click();
  await page.getByLabel('Folder name', { exact: true }).fill('Planning');
  await page
    .getByRole('button', { name: 'Create folder', exact: true })
    .click();
  const navigation = page.getByRole('navigation', {
    name: 'Workspace artifacts',
  });
  await navigation
    .getByRole('button', { name: 'Planning', exact: true })
    .click();
  const folderUrl = page.url();
  await expect(
    page.getByRole('heading', { name: 'Planning', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New artifact', exact: true }).click();
  await page
    .getByLabel('Artifact name', { exact: true })
    .fill('Pilot proposal');
  await page
    .getByLabel('Starting content')
    .fill('# Pilot proposal\n\nKeep every approval tied to a revision.');
  await page
    .getByRole('button', { name: 'Create artifact', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Artifact', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/[?&]artifact=/);
  const artifactUrl = page.url();
  const id = new URL(artifactUrl).searchParams.get('artifact')!;
  await navigation
    .getByRole('button', { name: 'Collapse Planning', exact: true })
    .click();
  await expect(
    navigation.getByRole('button', {
      name: 'Planning/Pilot proposal.md',
      exact: true,
    }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    navigation.getByRole('button', { name: 'Expand Planning', exact: true }),
  ).toBeVisible();
  await page.goto(folderUrl);
  await page
    .getByRole('button', { name: 'Manage folder', exact: true })
    .click();
  await page.getByLabel('Folder name', { exact: true }).fill('Decisions');
  await page.getByRole('button', { name: 'Save folder', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Decisions', exact: true }),
  ).toBeVisible();
  expect(page.url()).toBe(folderUrl);
  await page.goto(artifactUrl.replace('artifact=', 'document='));
  await expect(
    page.getByRole('heading', { name: 'Pilot proposal', exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator('.breadcrumb')).toContainText('Decisions');
  await manageArtifact(page);
  const dialog = page.getByRole('dialog', {
    name: 'Manage artifact',
    exact: true,
  });
  await choose(dialog.getByLabel('Folder', { exact: true }), 'Workspace root');
  await dialog
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(page.locator('.breadcrumb')).not.toContainText('Decisions');
  const updated = await (await page.request.get(`/api/artifacts/${id}`)).json();
  expect(updated.folderId).toBeNull();
  expect(updated.path).toBe('Pilot proposal.md');
  await page.goto(folderUrl);
  await page
    .getByRole('button', { name: 'Manage folder', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Delete empty folder', exact: true })
    .click();
  await expect(
    navigation.getByRole('button', { name: 'Decisions', exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
});
