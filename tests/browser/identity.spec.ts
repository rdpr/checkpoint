import { signOut } from './controls';
import { openSettings } from './controls';
import { test, expect } from '@playwright/test';

test('an existing reviewer connects Microsoft, signs out and returns through the OIDC browser flow', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('alex@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await openSettings(page, 'Account');
  await page.getByLabel('Current password').fill('browser-test-password-1234');
  await page
    .getByRole('button', { name: 'Connect Microsoft account', exact: true })
    .click();
  await page.waitForURL((url) => !url.searchParams.has('view'));
  await openSettings(page, 'Account');
  await expect(
    page.getByText('Your Microsoft account is connected.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '← Back to workspace' }).click();
  await signOut(page);
  // A second user cannot claim the same Microsoft identity; failure remains visible after redirect.
  await page.getByLabel('Email address').fill('sam@example.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill('browser-test-password-1234');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await openSettings(page, 'Account');
  await page.getByLabel('Current password').fill('browser-test-password-1234');
  await page
    .getByRole('button', { name: 'Connect Microsoft account', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'already linked to another account',
  );
  const independent = await browser.newContext();
  try {
    const other = await independent.newPage();
    await other.goto('/');
    await other
      .getByRole('button', { name: 'Sign in with Microsoft', exact: true })
      .click();
    await openSettings(other, 'Account');
    await expect(
      other.getByText('Your Microsoft account is connected.', { exact: false }),
    ).toBeVisible();
  } finally {
    await independent.close();
  }
});
