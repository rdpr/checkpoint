import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { authenticate, openSettings } from './controls';

test('browser recognizes Checkpoint as installable and respects a dismissed suggestion', async () => {
  // Installation is unavailable in incognito contexts. Use an isolated normal
  // profile and the real browser event, not a fabricated beforeinstallprompt.
  const directory = mkdtempSync(join(tmpdir(), 'checkpoint-install-'));
  const context = await chromium.launchPersistentContext(directory, {
    channel: 'chromium',
    headless: true,
    baseURL: 'http://127.0.0.1:4411',
    viewport: { width: 1280, height: 900 },
    args: ['--bypass-app-banner-engagement-checks'],
  });
  try {
    await authenticate(context.request, '/auth/login', {
      email: 'alex@example.test',
      password: 'browser-test-password-1234',
    });
    const page = context.pages()[0];
    await page.goto('/');
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(manifest.url).toBe('http://127.0.0.1:4411/manifest.webmanifest');
    const data = JSON.parse(manifest.data!);
    expect(data.display).toBe('standalone');
    expect(data.start_url).toBe('/');
    expect(data.id).toBe('/');
    const { installabilityErrors } = await cdp.send(
      'Page.getInstallabilityErrors',
    );
    expect(installabilityErrors).toEqual([]);
    const suggestion = page.getByRole('complementary', {
      name: 'Install Checkpoint',
      exact: true,
    });
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await suggestion
      .getByRole('button', { name: 'Dismiss install suggestion' })
      .click();
    await expect(suggestion).toBeHidden();
    await page.reload();
    await openSettings(page, 'Account');
    const settings = page.getByRole('region', {
      name: 'Install app',
      exact: true,
    });
    // Dismissing the promotion must not remove the explicit install action.
    await expect(
      settings.getByRole('button', { name: 'Install Checkpoint', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(suggestion).toBeHidden();
    await page.getByRole('button', { name: 'Dark appearance' }).click();
    await expect(page.locator('.brand-dark')).toBeVisible();
    await expect(page.locator('.brand-light')).toBeHidden();
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#14171d',
    );
    await page.getByRole('button', { name: 'Light appearance' }).click();
    await expect(page.locator('.brand-light')).toBeVisible();
    await expect(page.locator('.brand-dark')).toBeHidden();
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#f7f8fa',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await settings.getByText('Other ways to install', { exact: true }).click();
    await expect(settings.getByText(/Add to Home Screen/)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
