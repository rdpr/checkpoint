import { authenticate } from './controls';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

test.use({ actionTimeout: 15000 });
test('review revisions without retargeting feedback, then reattach a missing passage', async ({
  browser,
  page,
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
    const response = path.startsWith('/auth/') ? await authenticate(request, path, data) : await request.post(`/api${path}`, {
      headers: { Origin: origin },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  // This scenario owns a separate workspace and can also run on a fresh test DB.
  const status = await (await page.request.get('/api/auth/status')).json();
  await send(page.request, status.needsSetup ? '/auth/setup' : '/auth/login', {
    name: 'Alex Morgan',
    email: 'alex@example.test',
    password,
  });
  const workspace = await send(page.request, '/workspaces', {
    name: 'Revision review',
  });
  const body1 =
    '# Revision plan\n\nRemove this legacy task.\n\nKeep the stable task.\n\nA passage that will move.\n';
  const body2 =
    '# Revision plan\n\n## New approach\n\nChoose the new implementation.\n\nKeep the stable task.\n\nA passage that will move.\n';
  const body3 = body2 + '\nShip after the team review.\n';
  const doc = await send(page.request, '/artifacts', {
    workspaceId: workspace.id,
    path: 'review/plan.md',
    body: body1,
  });
  const url = `/?workspace=${workspace.id}&artifact=${doc.id}`;
  const other = await browser.newContext();
  const teammate = await other.newPage();
  teammate.on('pageerror', (e) => errors.push(e.message));
  const invitation = await send(
    page.request,
    `/workspaces/${workspace.id}/invitations`,
    { role: 'editor' },
  );
  await send(other.request, '/auth/register', {
    name: 'Revision Editor',
    email: 'revision-editor@example.test',
    password,
    invitation: invitation.token,
  });
  await page.goto(url);
  await teammate.goto(url);
  await page
    .locator('.artifact-surface')
    .getByText('Remove this legacy task.', { exact: true })
    .click({ clickCount: 3 });
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Keep the migration concern attached.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Keep the migration concern attached.', { exact: true }),
  ).toBeVisible();
  // A second old anchor exercises upstream carry-forward relocation.
  await page
    .locator('.artifact-surface')
    .getByText('A passage that will move.', { exact: true })
    .click({ clickCount: 3 });
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Track the moved passage.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Track the moved passage.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Finish review', exact: true })
    .click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  async function saveRevision(editor: Page, body: string) {
    await editor.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.locator('.cm-content[contenteditable="true"]').fill(body);
    await editor
      .getByRole('button', { name: 'Save revision', exact: true })
      .click();
    await expect(
      editor.getByText('All changes saved', { exact: true }),
    ).toBeVisible();
  }
  await saveRevision(teammate, body2);
  await expect(
    page.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Revision 2', { timeout: 12000 });
  const orphan = page
    .locator('.comment-card')
    .filter({ hasText: 'Keep the migration concern attached.' });
  await expect(orphan).toContainText('Unanchored');
  await expect(
    page
      .locator('.comment-card')
      .filter({ hasText: 'Track the moved passage.' }),
  ).toContainText('Passage moved');
  await page
    .getByRole('button', { name: 'Review changes', exact: true })
    .click();
  await expect(page.getByLabel('Comparison baseline')).toHaveText(/Revision 1/);
  await expect(
    page.getByText('From your reviewed revision', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  await expect(
    page.getByText('Use Rendered or Classic to comment on changes.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Classic', exact: true }).click();
  await page
    .locator('.plan-diff-removed')
    .filter({ hasText: 'Remove this legacy task.' })
    .click();
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Why was this removed?');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const diffComment = page
    .locator('.comment-card')
    .filter({ hasText: 'Why was this removed?' });
  await expect(diffComment).toContainText('Revision 1 → 2 · removed passage');
  await page.getByRole('button', { name: /^Rendered/ }).click();
  await page
    .getByRole('button', { name: 'Finish review', exact: true })
    .click();
  await page
    .getByLabel('Review note (optional)')
    .fill('Keep this note if someone saves.');
  await saveRevision(teammate, body3);
  await expect(
    page.getByText('This comparison stays on revision 2.', { exact: false }),
  ).toBeVisible({ timeout: 12000 });
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel('Review note (optional)')).toHaveValue(
    'Keep this note if someone saves.',
  );
  await expect(page.locator('.revision-diff')).not.toContainText(
    'Ship after the team review.',
  );
  await page.getByRole('button', { name: 'Keep draft for later' }).click();
  await page
    .getByRole('button', { name: 'Review latest changes', exact: true })
    .click();
  await expect(page.locator('.revision-diff')).toContainText(
    'Ship after the team review.',
  );
  await expect(page.getByLabel('Comparison baseline')).toHaveText(/Revision 1/);
  await page.getByRole('button', { name: 'Resume review draft' }).click();
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Discard review draft', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Finish review', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Changes requested');
  await diffComment
    .getByRole('button', { name: 'Open original comparison' })
    .click();
  await expect(page.locator('.comparison-banner')).toContainText(
    'to revision 2',
  );
  await expect(
    page.getByRole('button', { name: 'Finish review', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Artifact', exact: true }).click();
  await orphan.getByRole('button', { name: 'Reattach discussion' }).click();
  await page
    .locator('.artifact-surface')
    .getByText('Choose the new implementation.', { exact: true })
    .click({ clickCount: 3 });
  await page.locator('[data-selection-actions="true"]').click();
  await page.getByText('Attach discussion here', { exact: true }).click();
  await expect(orphan).toContainText('Reattached by Alex Morgan on revision 3');
  await expect(orphan).toContainText('Remove this legacy task.');
  await expect(orphan).toContainText('Choose the new implementation.');
  await expect(orphan).not.toContainText('Unanchored');
  await page.reload();
  await expect(
    page
      .locator('.artifact-surface mark')
      .filter({ hasText: 'Choose the new implementation.' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Update your review', exact: true })
    .click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Approved');
  const current = await (
    await page.request.get(`/api/artifacts/${doc.id}`)
  ).json();
  const feedback = await (
    await page.request.get(
      `/api/artifacts/${doc.id}/revisions/${current.currentRevisionId}/feedback`,
    )
  ).json();
  expect(feedback.markdown).toContain('Comparison: revision 1 → 2');
  expect(feedback.markdown).toContain('Reattached to revision 3');
  expect(feedback.markdown).toContain('Why was this removed?');
  await page
    .getByRole('button', { name: 'Review changes', exact: true })
    .click();
  await expect(page.locator('.revision-diff')).toContainText(
    'Ship after the team review.',
  );
  await page.screenshot({
    path: 'test-results/revision-review-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const rawControl = page.getByRole('button', { name: 'Raw', exact: true });
  await rawControl.scrollIntoViewIfNeeded();
  const rawBounds = await rawControl.boundingBox();
  expect(rawBounds!.x + rawBounds!.width).toBeLessThanOrEqual(390);

  await page
    .getByRole('button', { name: 'Raw', exact: true })
    .scrollIntoViewIfNeeded();
  await rawControl.click();
  await page.getByRole('button', { name: /^Rendered/ }).click();
  await page.screenshot({
    path: 'test-results/revision-review-mobile.png',
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
  await other.close();
});
