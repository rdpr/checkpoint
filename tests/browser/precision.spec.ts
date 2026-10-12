import { readingWidth } from './controls';
import { openSettings, startDiscussion, appearance } from './controls';
import { test, expect } from '@playwright/test';

// One user journey covers theme integration, routed settings, keyboard selection
// and a narrow-screen review. Persistence/authorization remain in the existing suite.
test('Precision keeps appearance, navigation and discussion context across devices and views', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const send = async (path: string, data: unknown) => {
    const response = await page.request.post('/api' + path, {
      headers: { Origin: 'http://127.0.0.1:4411' },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const status = await (await page.request.get('/api/auth/status')).json();
  await send(status.needsSetup ? '/auth/setup' : '/auth/login', {
    name: 'Alex Morgan',
    email: 'alex@example.test',
    password: 'browser-test-password-1234',
  });
  const workspace = await send('/workspaces', { name: 'Precision preview' });
  const doc = await send('/artifacts', {
    workspaceId: workspace.id,
    path: 'plans/readiness.md',
    body: '# Pilot readiness\n\nReview the exact saved revision.\n\n## Recovery\n\nKeep a verified backup before expanding the pilot.\n\n```ts\nconst ready = true;\n```',
  });
  await send(`/artifacts/${doc.id}/comments`, {
    revisionId: doc.currentRevisionId,
    quote: 'Review the exact saved revision.',
    body: 'Keep the revision visible when reviewing.',
  });
  const url = `/?workspace=${workspace.id}&artifact=${doc.id}`;
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Pilot readiness', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Contents', exact: true }).click();
  const contentsBounds = await page.locator('#artifact-contents').boundingBox();
  expect(contentsBounds!.x).toBeGreaterThanOrEqual(0);
  expect(contentsBounds!.x + contentsBounds!.width).toBeLessThanOrEqual(1440);
  await page
    .getByRole('button', { name: 'Close contents', exact: true })
    .click();
  await appearance(page, 'Dark');
  await expect(page.locator('html')).not.toHaveClass(/\blight\b/);
  await expect(page.locator('.app-main')).toHaveCSS(
    'background-color',
    'rgb(20, 23, 29)',
  );
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/\blight\b/);
  await readingWidth(page, 'Wide');
  await expect(page.locator('.review-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.locator('.review-panel')).toBeHidden();
  await page.getByRole('button', { name: 'Exit focus', exact: true }).click();
  await page
    .getByRole('button', { name: 'Review options', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Wide', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Finish review', exact: true })
    .click();
  await page
    .getByLabel('Review note (optional)')
    .fill('Keep this private note while I check settings.');
  await page.getByRole('button', { name: 'Keep draft for later' }).click();
  await openSettings(page, 'Account');
  await expect(page).toHaveURL(/view=account/);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Account', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('region', { name: 'Account', exact: true })
    .getByRole('button', { name: 'Light appearance' })
    .click();
  await page.getByRole('button', { name: '← Back to workspace' }).click();
  await page
    .getByRole('button', { name: 'Resume review draft', exact: true })
    .click();
  await expect(page.getByLabel('Review note (optional)')).toHaveValue(
    'Keep this private note while I check settings.',
  );
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Artifact review', exact: true }),
  ).toContainText('Approved');
  await openSettings(page, 'Organization');
  await page.getByRole('tab', { name: 'Teams', exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole('tab', { name: 'Teams', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '← Back to workspace' }).click();
  await page.getByLabel('Current workspace').focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('combobox', { name: 'Filter options' })
    .fill('Precision preview');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.goto(url);
  await appearance(page, 'Dark');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(
    page.locator('.cm-content[contenteditable="true"]'),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/precision-editor-dark.png' });
  await page.getByRole('button', { name: 'Artifact', exact: true }).click();
  await page.screenshot({ path: 'test-results/precision-review-dark.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Expand sidebar' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Discussion ·/ }).click();
  const discussion = page.getByRole('dialog', {
    name: 'Artifact discussion',
    exact: true,
  });
  await expect(discussion).toContainText(
    'Keep the revision visible when reviewing.',
  );
  await startDiscussion(page);
  await page
    .getByRole('textbox', { name: 'Artifact discussion', exact: true })
    .fill('Checked on a narrow screen.');
  await page
    .getByRole('dialog', { name: 'New discussion', exact: true })
    .getByRole('button', { name: 'Post', exact: true })
    .click();
  await expect(discussion).toContainText('Checked on a narrow screen.');
  await page.screenshot({
    path: 'test-results/precision-discussion-mobile.png',
  });
  await discussion.getByRole('button', { name: 'Return to artifact' }).click();
  await expect(discussion).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^Discussion ·/ }),
  ).toBeFocused();
  await page.screenshot({ path: 'test-results/precision-review-mobile.png' });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

// Regressions from the visual audit: hidden select inputs must not create a
// second page scrollbar, and long settings screens must remain reachable.
test('settings stay inside the viewport and sidebar actions give consistent feedback', async ({
  page,
}) => {
  const status = await (await page.request.get('/api/auth/status')).json();
  const authentication = await page.request.post(
    '/api' + (status.needsSetup ? '/auth/setup' : '/auth/login'),
    {
      headers: { Origin: 'http://127.0.0.1:4411' },
      data: {
        name: 'Alex Morgan',
        email: 'alex@example.test',
        password: 'browser-test-password-1234',
      },
    },
  );
  expect(authentication.ok(), await authentication.text()).toBeTruthy();
  const workspace = (
    await (await page.request.get('/api/workspaces')).json()
  )[0];
  const nested = await page.request.post('/api/artifacts', {
    headers: { Origin: 'http://127.0.0.1:4411' },
    data: {
      workspaceId: workspace.id,
      path: 'Navigation/Subfolder/hover-review.md',
      body: '# Sidebar review',
    },
  });
  expect(nested.ok(), await nested.text()).toBeTruthy();
  await page.goto(`/?workspace=${workspace.id}`);
  for (const name of [
    'Search',
    'My reviews',
    /^Notifications/,
    'Saved drafts',
    /^All artifacts/,
    /^Account menu for /,
    'Sign out',
  ]) {
    const button = page
      .locator('.sidebar')
      .getByRole('button', { name, exact: typeof name === 'string' });
    await page.mouse.move(1200, 20);
    const before = await button.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await button.hover();
    await expect
      .poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(before);
    await button.focus();
    await expect(button).toBeFocused();
  }
  const accountMenu = page.getByRole('button', { name: /^Account menu for / });
  await accountMenu.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('menu', { name: 'Account and settings' }),
  ).toBeVisible();
  await expect(
    page.getByRole('menuitem', { name: 'Account & appearance', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(accountMenu).toBeFocused();
  const tree = page.getByRole('navigation', { name: 'Workspace artifacts' });
  const root = tree.locator('.folder-tree-row').filter({
    has: page.getByRole('button', { name: 'Navigation', exact: true }),
  });
  const child = tree.locator('.folder-tree-row').filter({
    has: page.getByRole('button', { name: 'Subfolder', exact: true }),
  });
  const artifact = tree.getByRole('button', {
    name: 'Navigation/Subfolder/hover-review.md', exact: true,
  });
  const rootBounds = (await root.boundingBox())!;
  for (const row of [child, artifact]) {
    const bounds = (await row.boundingBox())!;
    expect(bounds.x).toBeCloseTo(rootBounds.x, 0);
    expect(bounds.width).toBeCloseTo(rootBounds.width, 0);
  }
  for (const control of [
    child.getByRole('button', { name: 'Collapse Subfolder' }),
    child.getByRole('button', { name: 'Subfolder', exact: true }),
    child.getByRole('button', { name: 'Actions for folder Subfolder' }),
  ]) {
    await control.hover();
    await expect(child).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  await openSettings(page, 'Agent access');
  await expect(page.getByLabel('Service account name')).toBeAttached();
  const pageFits = () =>
    page.evaluate(() => ({
      width: document.documentElement.scrollWidth <= innerWidth,
      height: document.documentElement.scrollHeight <= innerHeight + 1,
    }));
  await expect.poll(pageFits).toEqual({ width: true, height: true });
  await page
    .getByRole('button', { name: 'Create service account', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: 'Create service account', exact: true }),
  ).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 10000));
  expect(await page.evaluate(() => scrollY)).toBe(0);
  const bounds = await page
    .getByRole('region', { name: 'Connect your agent' })
    .boundingBox();
  expect(bounds!.x + bounds!.width).toBeCloseTo(1440, 0);
  await openSettings(page, 'Members');
  const owner = await page
    .getByLabel('Current owner', { exact: true })
    .boundingBox();
  const successor = await page
    .getByLabel('New owner', { exact: true })
    .boundingBox();
  expect(successor!.y - (owner!.y + owner!.height)).toBeGreaterThanOrEqual(16);
  await openSettings(page, 'Organization');
  await page.getByRole('tab', { name: 'Audit log', exact: true }).click();
  await expect(
    page.getByRole('columnheader', { name: 'Changed by', exact: true }),
  ).toBeVisible();
  const details = page
    .getByRole('button', { name: 'Change details', exact: true })
    .first();
  await details.click();
  await expect(
    page.getByRole('button', { name: 'Hide details', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: 'test-results/precision-audit-table.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(pageFits).toEqual({ width: true, height: true });
  await page.screenshot({ path: 'test-results/precision-audit-mobile.png' });
  await openSettings(page, 'Members');
  await expect.poll(pageFits).toEqual({ width: true, height: true });
  await page
    .getByRole('button', { name: 'Transfer ownership', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: 'Transfer ownership', exact: true }),
  ).toBeInViewport();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
