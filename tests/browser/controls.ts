import type { Locator, Page } from '@playwright/test';

export async function choose(control: Locator, label: string) {
  await control.click();
  const name = new RegExp(
    '^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?: ·.*)?$',
  );
  await control.page().getByRole('option', { name }).click();
}

export async function openSettings(page: Page, section: string) {
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  if (await tabs.isVisible()) {
    await tabs.getByRole('button', { name: section, exact: true }).click();
    return;
  }
  await page.getByRole('button', { name: /^Account menu for / }).click();
  await page
    .getByRole('menuitem', {
      name: section === 'Account' ? 'Account & appearance' : section,
      exact: true,
    })
    .click();
}
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}
export async function startDiscussion(page: Page) {
  if (
    !(await page
      .getByRole('dialog', { name: 'New discussion', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', {
        name: /^(New discussion|Resume discussion draft)$/,
      })
      .click();
}
export async function appearance(
  page: Page,
  mode: 'Dark' | 'Light' | 'System',
) {
  await openSettings(page, 'Account');
  await page.getByRole('button', { name: `${mode} appearance` }).click();
  await page.getByRole('button', { name: '← Back to workspace' }).click();
}
export async function manageArtifact(page: Page) {
  if (
    !(await page
      .getByRole('button', { name: 'Manage artifact', exact: true })
      .isVisible())
  )
    await page
      .getByRole('button', { name: 'Artifact actions', exact: true })
      .click();
  await page
    .getByRole('button', { name: 'Manage artifact', exact: true })
    .click();
}

export async function readingWidth(page: Page, value: 'Normal' | 'Wide') {
  await page
    .getByRole('button', { name: 'Review options', exact: true })
    .click();
  await page.getByRole('button', { name: value, exact: true }).click();
}
