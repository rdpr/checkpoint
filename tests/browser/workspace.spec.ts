import { signOut } from './controls';
import { readingWidth } from './controls';
import { openSettings, startDiscussion } from './controls';
import { choose } from './controls';
import { test, expect, type Page } from '@playwright/test';

test.use({ actionTimeout: 15_000 });

const password = 'browser-test-password-1234';
async function replaceMarkdown(page: Page, text: string) {
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill(text);
}

test('two people create, review, edit, handle conflicts and restore a shared artifact', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByLabel('Your name').fill('Alex Morgan');
  await page.getByLabel('Email address').fill('alex@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create your workspace' }).click();
  await expect(
    page.getByRole('heading', { name: 'My workspace' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'New artifact', exact: true })
    .last()
    .click();
  await page.getByLabel('Artifact name').fill('release');
  await page
    .getByLabel('Starting content')
    .fill(
      '# Release plan\n\nShip a useful workspace for people and agents.\n\n## Success criteria\n\nKeep every revision and make discussions durable.\n\n## Model\n\nThe cost is $x^2$.\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```',
    );
  await page
    .getByRole('button', { name: 'Create artifact', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Release plan', exact: true }),
  ).toBeVisible();
  const artifactUrl = page.url();
  await startDiscussion(page);
  await page
    .getByLabel('Artifact discussion')
    .fill('Let’s verify persistence before launch.');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(
    page.getByText('Let’s verify persistence before launch.'),
  ).toBeVisible();
  await openSettings(page, 'Members');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const invitation = await page.getByLabel('Invitation link').inputValue();
  await page.getByRole('button', { name: '← Back to workspace' }).click();
  const other = await browser.newContext();
  const teammate = await other.newPage();
  teammate.on('pageerror', (e) => errors.push(e.message));
  await teammate.goto(invitation);
  await teammate.getByLabel('Your name').fill('Sam Rivera');
  await teammate.getByLabel('Email address').fill('sam@example.test');
  await teammate.getByLabel('Password', { exact: true }).fill(password);
  await teammate.getByRole('button', { name: 'Create account & join' }).click();
  await expect(
    teammate.getByRole('heading', { name: 'My workspace' }),
  ).toBeVisible();
  await teammate.goto(artifactUrl);
  await expect(
    teammate.getByText('Let’s verify persistence before launch.'),
  ).toBeVisible();
  await teammate.getByRole('button', { name: 'Reply', exact: true }).click();
  await teammate
    .getByLabel('Reply to discussion')
    .fill('I’ll check recovery after restart.');
  await teammate
    .getByRole('button', { name: 'Send reply', exact: true })
    .click();
  await expect(
    page.getByText('I’ll check recovery after restart.'),
  ).toBeVisible({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Resolve discussion' }).click();
  await page.getByRole('button', { name: 'All activity', exact: true }).click();
  await expect(page.getByText('Resolved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen discussion' }).click();
  await page
    .getByText('Ship a useful workspace for people and agents.', {
      exact: true,
    })
    .click({ clickCount: 3 });
  await expect(
    page.getByPlaceholder('Add a comment...', { exact: true }),
  ).toBeVisible();
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Keep the human and agent workflow in scope.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Keep the human and agent workflow in scope.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator('.artifact-surface mark').filter({
      hasText: 'Ship a useful workspace for people and agents.',
    }),
  ).toBeVisible();
  // Human reviews are shared and belong to the exact saved revision.
  await page.getByRole('button', { name: 'Finish review' }).click();
  await page
    .getByLabel('Review note (optional)')
    .fill('Ready for implementation.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    teammate.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Approved', { timeout: 12_000 });
  await teammate.getByRole('button', { name: 'Finish review' }).click();
  await teammate
    .getByLabel('Review note (optional)')
    .fill('Please check recovery.');
  await teammate
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Changes requested', { timeout: 12_000 });
  await teammate.getByRole('button', { name: 'Update your review' }).click();
  await teammate.getByRole('button', { name: 'Withdraw review' }).click();
  await expect(
    page.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Approved', { timeout: 12_000 });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await teammate.getByRole('button', { name: 'Edit', exact: true }).click();
  await replaceMarkdown(
    page,
    '# Release plan\n\nOwner has saved the launch criteria.',
  );
  await replaceMarkdown(teammate, '# Release plan\n\nSam’s unsaved proposal.');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(
    page.getByText('Owner has saved the launch criteria.'),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Changes since approval');
  await expect(
    page.getByText('Unanchored — passage missing from this revision'),
  ).toBeVisible();
  // The poll may detect the conflict before the save click; both paths must preserve the draft.
  const save = teammate.getByRole('button', { name: 'Save revision' });
  if (await save.isEnabled()) {
    // Polling can disable Save between isEnabled and Playwright's actionability check.
    try {
      await save.click({ timeout: 1000 });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TimeoutError')
        throw error;
      await expect(save).toBeDisabled();
    }
  }
  await expect(
    teammate.getByText('A newer revision is available. Your draft is safe.'),
  ).toBeVisible({ timeout: 12_000 });
  await teammate.reload();
  await expect(
    teammate.locator('.cm-content[contenteditable="true"]'),
  ).toContainText('Sam’s unsaved proposal.');
  await teammate
    .getByRole('button', { name: 'Compare with latest', exact: true })
    .click();
  await expect(teammate.locator('.artifact-surface')).toContainText(
    'the launch criteria',
  );
  await teammate.getByRole('button', { name: 'Use latest as base' }).click();
  await replaceMarkdown(
    teammate,
    '# Release plan\n\nOwner launch criteria plus Sam’s recovery checks.',
  );
  await teammate.getByRole('button', { name: 'Save revision' }).click();
  await expect(
    teammate.getByText('Owner launch criteria plus Sam’s recovery checks.'),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText('Owner launch criteria plus Sam’s recovery checks.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: /Revision 1/ }).click();
  await expect(
    page.getByText('Viewing revision 1', { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .locator('.artifact-surface mark')
      .filter({ hasText: 'Ship a useful workspace' }),
  ).toBeVisible();
  await page
    .locator('.artifact-surface mark')
    .filter({ hasText: 'Ship a useful workspace' })
    .click();
  await expect(page.locator('.comment-card.selected')).toContainText(
    'Keep the human',
  );
  await expect(
    page.getByPlaceholder('Add a comment...', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Artifact review' }),
  ).toContainText('Approved');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Confirm action' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(
    page
      .locator('.artifact-surface')
      .getByText('Ship a useful workspace for people and agents.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('button', { name: /Revision 4/ })).toBeVisible();
  await page
    .locator('.reading-controls')
    .getByRole('button', { name: /^Discussion/ })
    .click();
  const reviewTools = page.locator('[data-viewer-annotation-controls]');
  await reviewTools
    .getByRole('button', { name: 'Pinpoint', exact: true })
    .click();
  await reviewTools
    .getByRole('button', { name: 'Markup', exact: true })
    .click();
  const criteria = page
    .locator('.artifact-surface')
    .getByText('Keep every revision and make discussions durable.', {
      exact: true,
    });
  await criteria.hover();
  await expect(page.locator('[data-pinpoint-overlay]')).toBeVisible();
  await criteria.click();
  await page
    .locator('[data-pn-annotation-toolbar-row]')
    .getByRole('button', { name: 'Comment', exact: true })
    .click();
  const composer = page.getByPlaceholder('Add a comment...', { exact: true });
  await composer.fill('A pinpoint comment with evidence.');
  const saveHint = await page
    .locator('[data-comment-popover] button.bg-primary')
    .evaluate((button) => getComputedStyle(button, '::after').content);
  expect(saveHint).toContain('Enter');
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
  const picture = await page.locator('.artifact-surface').screenshot();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'review-evidence.png',
    mimeType: 'image/png',
    buffer: picture,
  });
  await page.getByTitle('Save (Esc)', { exact: true }).click();
  await expect(page.locator('[data-comment-popover] img')).toBeVisible();
  await composer.press('Control+Enter');
  const evidence = page
    .locator('.comment-card')
    .filter({ hasText: 'A pinpoint comment with evidence.' });
  await expect(
    evidence.getByRole('img', { name: 'review-evidence' }),
  ).toBeVisible();
  await expect(
    teammate.getByText('A pinpoint comment with evidence.'),
  ).toBeVisible({ timeout: 12_000 });
  // Direct redline mode creates a suggestion without replacing Markdown.
  await reviewTools
    .getByRole('button', { name: 'Redline', exact: true })
    .click();
  await page
    .locator('.artifact-surface')
    .getByRole('heading', { name: 'Success criteria' })
    .click();
  await expect(
    page.getByText('Suggested deletion', { exact: true }),
  ).toBeVisible();
  await reviewTools
    .getByRole('button', { name: 'Select', exact: true })
    .click();
  await reviewTools.getByRole('button', { name: 'Label', exact: true }).click();
  await page
    .locator('.artifact-surface')
    .getByRole('heading', { name: 'Release plan', exact: true })
    .click({ clickCount: 3 });
  await page.getByRole('button', { name: /Verify this/ }).click();
  await expect(
    page.locator('.comment-card').filter({ hasText: 'Verify this' }),
  ).toContainText('Verify by reading the actual code');
  await page.reload();
  await expect(
    page
      .locator('.artifact-surface mark.deletion')
      .filter({ hasText: 'Success criteria' }),
  ).toBeVisible();
  await expect(
    page.locator('.comment-card').filter({ hasText: 'Verify this' }),
  ).toBeVisible();
  await expect(evidence.locator('img')).toBeVisible();
  expect(
    await evidence
      .locator('img')
      .evaluate((img) => (img as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  const resolveEvidence = evidence.getByRole('button', {
    name: 'Resolve discussion',
  });
  await expect(resolveEvidence).toHaveText('Resolve discussion');
  await resolveEvidence.click();
  await page.getByRole('button', { name: 'All activity', exact: true }).click();
  await expect(evidence.getByText('Resolved', { exact: true })).toBeVisible();
  await evidence.getByRole('button', { name: 'Reopen discussion' }).click();
  await evidence.getByRole('button', { name: 'Discussion actions' }).click();
  await page
    .getByRole('button', { name: 'Edit annotation', exact: true })
    .click();
  await evidence
    .getByLabel('Edit annotation', { exact: true })
    .fill('Updated evidence after team review.');
  await page.getByRole('button', { name: 'Save annotation' }).click();
  const updatedEvidence = page
    .locator('.comment-card')
    .filter({ hasText: 'Updated evidence after team review.' });
  await expect(updatedEvidence).toContainText('Edited');
  await expect(updatedEvidence.locator('img')).toBeVisible();
  await expect(
    teammate.getByText('Updated evidence after team review.'),
  ).toBeVisible({ timeout: 12_000 });
  await expect(
    teammate
      .locator('.comment-card')
      .filter({ hasText: 'Updated evidence after team review.' })
      .getByRole('button', { name: 'Edit annotation' }),
  ).toHaveCount(0);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.feedback-disclosure > summary').click();
  await page.getByRole('button', { name: 'Copy review feedback' }).click();
  await expect(
    page.getByRole('button', { name: 'Feedback copied' }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'Updated evidence after team review.',
  );
  const exportDownload = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download feedback', exact: true })
    .click();
  const downloaded = await exportDownload;
  const stream = await downloaded.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const feedback = Buffer.concat(chunks).toString();
  expect(feedback).toContain('Updated evidence after team review.');
  expect(feedback).toContain('Changes since approval');
  expect(feedback).toContain('review-evidence');
  await updatedEvidence
    .getByRole('button', { name: 'Discussion actions' })
    .click();
  await page.getByRole('button', { name: 'Delete discussion' }).click();
  await page
    .getByRole('dialog', { name: 'Confirm action' })
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(updatedEvidence).toHaveCount(0);
  await expect(
    teammate.getByText('Updated evidence after team review.'),
  ).toHaveCount(0, { timeout: 12_000 });

  // Rich targets are created through upstream UI, then restored after reload.
  await reviewTools
    .getByRole('button', { name: 'Comment', exact: true })
    .click();
  await page.locator('.artifact-surface .math-annotatable').first().click();
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Check the cost formula.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const node = page
    .locator('.artifact-surface svg .node')
    .filter({ hasText: 'Start' });
  await node.click();
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Validate the starting node.');
  await page
    .locator('[data-diagram-composer]')
    .getByRole('button', { name: 'Comment', exact: true })
    .click();
  await page.reload();
  await expect(
    page.locator('.artifact-surface [data-math-annotation="true"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Comment 1: Start/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: /Revision 4/ }).click();
  await expect(
    page.locator('.artifact-surface [data-math-annotation="true"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Comment 1: Start/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await page
    .locator('.reading-controls')
    .getByRole('button', { name: /^Discussion/ })
    .click();
  // Reading layout, navigation, and personal presets survive reload and account switches.
  const reading = page.getByRole('region', { name: 'Reading controls' });
  await readingWidth(page, 'Wide');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.review-panel')).toBeVisible();
  const wideWidth = (await page.locator('.artifact-surface').boundingBox())!
    .width;
  await reading.getByRole('button', { name: 'Focus', exact: true }).click();
  expect(
    (await page.locator('.artifact-surface').boundingBox())!.width,
  ).toBeLessThanOrEqual(832);
  await page.reload();
  await expect(
    reading.getByRole('button', { name: 'Exit focus', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 1440, height: 700 });
  await reading.getByRole('button', { name: 'Contents', exact: true }).click();
  const contents = page.getByRole('navigation', { name: 'Table of contents' });
  await expect(
    contents.getByRole('button', { name: /Success criteria/ }),
  ).toBeVisible();
  await contents.getByRole('button', { name: /Model/ }).click();
  await expect(
    page
      .locator('.artifact-surface')
      .getByRole('heading', { name: 'Model', exact: true }),
  ).toBeInViewport();
  await expect
    .poll(() => page.locator('.artifact-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await readingWidth(page, 'Normal');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.review-panel')).toBeVisible();
  await reading.getByRole('button', { name: 'Review options' }).click();
  await page
    .getByRole('button', { name: 'Custom labels', exact: true })
    .click();
  const labels = page.getByRole('dialog', {
    name: 'Custom labels',
    exact: true,
  });
  await labels
    .getByRole('button', { name: '+ Add label', exact: true })
    .click();
  await labels
    .getByRole('textbox', { name: 'Label text, position 11', exact: true })
    .fill('Check rollout');
  await labels
    .getByRole('textbox', { name: 'Emoji for Check rollout' })
    .fill('🛟');
  await labels.getByLabel('Colour for Check rollout').selectOption('teal');
  const customRow = labels.locator('[data-quick-label-row]').filter({
    has: page.getByRole('textbox', { name: 'Emoji for Check rollout' }),
  });
  await customRow.getByTitle('Add AI instruction tip', { exact: true }).click();
  await labels
    .getByLabel('AI instruction tip for Check rollout')
    .fill('Verify the rollback procedure before release.');
  await labels.getByTitle('Save tip', { exact: true }).click();
  await labels
    .getByRole('button', { name: 'Move Check rollout up', exact: true })
    .click();
  await expect(
    labels.getByLabel('Label text, position 10', { exact: true }),
  ).toHaveValue('Check rollout');
  await labels.getByRole('button', { name: 'Close dialog' }).click();
  await reviewTools
    .getByRole('button', { name: 'Pinpoint', exact: true })
    .click();
  await reviewTools.getByRole('button', { name: 'Label', exact: true }).click();
  await page.getByRole('button', { name: 'All activity', exact: true }).click();
  await page.reload();
  await expect(
    reviewTools.getByRole('button', { name: 'Pinpoint', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    reviewTools.getByRole('button', { name: 'Label', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'All activity', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await reading.getByRole('button', { name: 'Review options' }).click();
  await page
    .getByRole('button', { name: 'Custom labels', exact: true })
    .click();
  await expect(
    labels.getByLabel('Label text, position 10', { exact: true }),
  ).toHaveValue('Check rollout');
  await expect(labels.getByLabel('Emoji for Check rollout')).toHaveValue('🛟');
  await expect(labels.getByLabel('Colour for Check rollout')).toHaveValue(
    'teal',
  );
  await page.screenshot({ path: 'test-results/custom-labels.png' });
  await labels.getByRole('button', { name: 'Close dialog' }).click();
  await page
    .locator('.artifact-surface')
    .getByRole('heading', { name: 'Model', exact: true })
    .click();
  await page.getByRole('button', { name: /Check rollout/ }).click();
  await expect(
    page.locator('.comment-card').filter({ hasText: 'Check rollout' }),
  ).toContainText('Verify the rollback procedure before release.');
  await expect(
    teammate.locator('.comment-card').filter({ hasText: 'Check rollout' }),
  ).toContainText('Verify the rollback procedure before release.', {
    timeout: 12_000,
  });
  await signOut(page);
  await page.getByLabel('Email address').fill('sam@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Account menu for / }),
  ).toBeVisible();
  await page.goto(artifactUrl);
  await expect(
    reviewTools.getByRole('button', { name: 'Comment', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    reviewTools.getByRole('button', { name: 'Select', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Open', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await reading.getByRole('button', { name: 'Review options' }).click();
  await page
    .getByRole('button', { name: 'Custom labels', exact: true })
    .click();
  await expect(
    labels.getByRole('textbox', { name: 'Emoji for Check rollout' }),
  ).toHaveCount(0);
  await labels.getByRole('button', { name: 'Close dialog' }).click();
  await signOut(page);
  await page.getByLabel('Email address').fill('alex@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Account menu for / }),
  ).toBeVisible();
  await page.goto(artifactUrl);
  await expect(
    reviewTools.getByRole('button', { name: 'Label', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  // A viewer sees restored highlights but has no annotation or approval controls.
  await openSettings(page, 'Members');
  await choose(page.getByLabel('Invite someone as'), 'Viewer — read only');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const viewerInvite = await page.getByLabel('Invitation link').inputValue();
  await page.getByRole('button', { name: '← Back to workspace' }).click();
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  viewer.on('pageerror', (e) => errors.push(e.message));
  await viewer.goto(viewerInvite);
  await viewer.getByLabel('Your name').fill('Taylor Reader');
  await viewer.getByLabel('Email address').fill('taylor@example.test');
  await viewer.getByLabel('Password', { exact: true }).fill(password);
  await viewer.getByRole('button', { name: 'Create account & join' }).click();
  await expect(
    viewer.getByRole('heading', { name: 'My workspace' }),
  ).toBeVisible();
  await viewer.goto(artifactUrl);
  await expect(
    viewer
      .locator('.artifact-surface mark')
      .filter({ hasText: 'Ship a useful workspace' }),
  ).toBeVisible();
  await expect(
    viewer.locator('.artifact-surface [data-math-annotation="true"]'),
  ).toBeVisible();
  await expect(
    viewer.getByRole('button', { name: /Comment 1: Start/ }),
  ).toBeVisible();
  await expect(viewer.locator('[data-viewer-annotation-controls]')).toHaveCount(
    0,
  );
  await expect(
    viewer.getByRole('button', { name: 'Finish review' }),
  ).toHaveCount(0);
  await viewer.locator('.artifact-surface .math-annotatable').first().click();
  await expect(
    viewer.getByPlaceholder('Add a comment...', { exact: true }),
  ).toHaveCount(0);
  await viewerContext.close();
  await page.screenshot({
    path: 'test-results/workspace-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'Expand sidebar' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Release plan', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await reading.getByRole('button', { name: 'Contents', exact: true }).click();
  await contents.getByRole('button', { name: /Model/ }).click();
  await expect(
    page
      .locator('.artifact-surface')
      .getByRole('heading', { name: 'Model', exact: true }),
  ).toBeInViewport();
  await expect
    .poll(() => page.locator('.artifact-layout').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.screenshot({
    path: 'test-results/workspace-mobile.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await other.close();
});
