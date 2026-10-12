import { test, expect, type Page } from '@playwright/test';

test.use({ actionTimeout: 15_000 });

const password = 'browser-test-password-1234';
async function replaceMarkdown(page: Page, text: string) {
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill(text);
}

test('two people create, review, edit, handle conflicts and restore a shared document', async ({
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
    page.getByRole('heading', { name: 'My workspace.' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'New document', exact: true })
    .last()
    .click();
  await page.getByLabel('Document path').fill('plans/release.md');
  await page
    .getByLabel('Starting content')
    .fill(
      '# Release plan\n\nShip a useful workspace for people and agents.\n\n## Success criteria\n\nKeep every revision and make discussions durable.\n\n## Model\n\nThe cost is $x^2$.\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```',
    );
  await page
    .getByRole('button', { name: 'Create document', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Release plan', exact: true }),
  ).toBeVisible();
  const documentUrl = page.url();
  await page
    .getByLabel('Document discussion')
    .fill('Let’s verify persistence before launch.');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(
    page.getByText('Let’s verify persistence before launch.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const invitation = await page.getByLabel('Invitation link').inputValue();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const other = await browser.newContext();
  const teammate = await other.newPage();
  teammate.on('pageerror', (e) => errors.push(e.message));
  await teammate.goto(invitation);
  await teammate.getByLabel('Your name').fill('Sam Rivera');
  await teammate.getByLabel('Email address').fill('sam@example.test');
  await teammate.getByLabel('Password', { exact: true }).fill(password);
  await teammate.getByRole('button', { name: 'Create account & join' }).click();
  await expect(
    teammate.getByRole('heading', { name: 'My workspace.' }),
  ).toBeVisible();
  await teammate.goto(documentUrl);
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
  await page.getByLabel('Show resolved').check();
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
    page.locator('.document-surface mark').filter({
      hasText: 'Ship a useful workspace for people and agents.',
    }),
  ).toBeVisible();
  // Human reviews are shared and belong to the exact saved revision.
  await page.getByRole('button', { name: 'Review this revision' }).click();
  await page
    .getByLabel('Review note (optional)')
    .fill('Ready for implementation.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    teammate.getByRole('region', { name: 'Document review' }),
  ).toContainText('Approved', { timeout: 12_000 });
  await teammate.getByRole('button', { name: 'Review this revision' }).click();
  await teammate
    .getByLabel('Review note (optional)')
    .fill('Please check recovery.');
  await teammate
    .getByRole('button', { name: 'Request changes', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Document review' }),
  ).toContainText('Changes requested', { timeout: 12_000 });
  await teammate.getByRole('button', { name: 'Update your review' }).click();
  await teammate.getByRole('button', { name: 'Withdraw review' }).click();
  await expect(
    page.getByRole('region', { name: 'Document review' }),
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
    page.getByRole('region', { name: 'Document review' }),
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
  await expect(teammate.locator('.document-surface')).toContainText(
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
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /Revision 1/ }).click();
  await expect(
    page.getByText('Viewing revision 1', { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .locator('.document-surface mark')
      .filter({ hasText: 'Ship a useful workspace' }),
  ).toBeVisible();
  await page
    .locator('.document-surface mark')
    .filter({ hasText: 'Ship a useful workspace' })
    .click();
  await expect(page.locator('.comment-card.selected')).toContainText(
    'Keep the human',
  );
  await expect(
    page.getByPlaceholder('Add a comment...', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Document review' }),
  ).toContainText('Approved');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(
    page
      .locator('.document-surface')
      .getByText('Ship a useful workspace for people and agents.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: /Revision 4/ })).toBeVisible();
  await page.getByRole('button', { name: /^Discussion/ }).click();
  const reviewTools = page.getByRole('region', { name: 'Review tools' });
  await reviewTools
    .getByRole('button', { name: 'Pinpoint', exact: true })
    .click();
  await reviewTools
    .getByRole('button', { name: 'Markup', exact: true })
    .click();
  const criteria = page
    .locator('.document-surface')
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
  const picture = await page.locator('.document-surface').screenshot();
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
    .locator('.document-surface')
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
    .locator('.document-surface')
    .getByRole('heading', { name: 'Release plan', exact: true })
    .click({ clickCount: 3 });
  await page.getByRole('button', { name: /Verify this/ }).click();
  await expect(
    page.locator('.comment-card').filter({ hasText: 'Verify this' }),
  ).toContainText('Verify by reading the actual code');
  await page.reload();
  await expect(
    page
      .locator('.document-surface mark.deletion')
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
  await page.getByLabel('Show resolved').check();
  await expect(evidence.getByText('Resolved', { exact: true })).toBeVisible();
  await evidence.getByRole('button', { name: 'Reopen discussion' }).click();
  await evidence
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
  page.once('dialog', (dialog) => dialog.accept());
  await updatedEvidence
    .getByRole('button', { name: 'Delete discussion' })
    .click();
  await expect(updatedEvidence).toHaveCount(0);
  await expect(
    teammate.getByText('Updated evidence after team review.'),
  ).toHaveCount(0, { timeout: 12_000 });

  // Rich targets are created through upstream UI, then restored after reload.
  await reviewTools
    .getByRole('button', { name: 'Comment', exact: true })
    .click();
  await page.locator('.document-surface .math-annotatable').first().click();
  await page
    .getByPlaceholder('Add a comment...', { exact: true })
    .fill('Check the cost formula.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const node = page
    .locator('.document-surface svg .node')
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
    page.locator('.document-surface [data-math-annotation="true"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Comment 1: Start/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /Revision 4/ }).click();
  await expect(
    page.locator('.document-surface [data-math-annotation="true"]'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Comment 1: Start/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back to latest' }).click();
  await page.getByRole('button', { name: /^Discussion/ }).click();
  // Reading layout, navigation, and personal presets survive reload and account switches.
  const reading = page.getByRole('region', { name: 'Reading controls' });
  await reading.getByRole('button', { name: 'Wide', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.locator('.review-panel')).toBeHidden();
  const wideWidth = (await page.locator('.document-surface').boundingBox())!
    .width;
  await reading.getByRole('button', { name: 'Focus', exact: true }).click();
  expect(
    (await page.locator('.document-surface').boundingBox())!.width,
  ).toBeLessThan(wideWidth);
  await page.reload();
  await expect(
    reading.getByRole('button', { name: 'Focus', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await reading.getByRole('button', { name: 'Contents', exact: true }).click();
  const contents = page.getByRole('navigation', { name: 'Table of contents' });
  await expect(
    contents.getByRole('button', { name: /Success criteria/ }),
  ).toBeVisible();
  await contents.getByRole('button', { name: /Model/ }).click();
  await expect(
    page
      .locator('.document-surface')
      .getByRole('heading', { name: 'Model', exact: true }),
  ).toBeInViewport();
  await expect
    .poll(() => page.locator('.document-scroll').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await reading.getByRole('button', { name: 'Normal', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.review-panel')).toBeVisible();
  await reading.getByRole('button', { name: 'Custom labels' }).click();
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
  await page.getByLabel('Show resolved').check();
  await page.reload();
  await expect(
    reviewTools.getByRole('button', { name: 'Pinpoint', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    reviewTools.getByRole('button', { name: 'Label', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Show resolved')).toBeChecked();
  await reading.getByRole('button', { name: 'Custom labels' }).click();
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
    .locator('.document-surface')
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
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email address').fill('sam@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
  await page.goto(documentUrl);
  await expect(
    reviewTools.getByRole('button', { name: 'Comment', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    reviewTools.getByRole('button', { name: 'Select', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Show resolved')).not.toBeChecked();
  await reading.getByRole('button', { name: 'Custom labels' }).click();
  await expect(
    labels.getByRole('textbox', { name: 'Emoji for Check rollout' }),
  ).toHaveCount(0);
  await labels.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email address').fill('alex@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign out', exact: true }),
  ).toBeVisible();
  await page.goto(documentUrl);
  await expect(
    reviewTools.getByRole('button', { name: 'Label', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  // A viewer sees restored highlights but has no annotation or approval controls.
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByLabel('Invite someone as').selectOption('viewer');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const viewerInvite = await page.getByLabel('Invitation link').inputValue();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  viewer.on('pageerror', (e) => errors.push(e.message));
  await viewer.goto(viewerInvite);
  await viewer.getByLabel('Your name').fill('Taylor Reader');
  await viewer.getByLabel('Email address').fill('taylor@example.test');
  await viewer.getByLabel('Password', { exact: true }).fill(password);
  await viewer.getByRole('button', { name: 'Create account & join' }).click();
  await expect(
    viewer.getByRole('heading', { name: 'My workspace.' }),
  ).toBeVisible();
  await viewer.goto(documentUrl);
  await expect(
    viewer
      .locator('.document-surface mark')
      .filter({ hasText: 'Ship a useful workspace' }),
  ).toBeVisible();
  await expect(
    viewer.locator('.document-surface [data-math-annotation="true"]'),
  ).toBeVisible();
  await expect(
    viewer.getByRole('button', { name: /Comment 1: Start/ }),
  ).toBeVisible();
  await expect(
    viewer.getByRole('region', { name: 'Review tools' }),
  ).toHaveCount(0);
  await expect(
    viewer.getByRole('button', { name: 'Review this revision' }),
  ).toHaveCount(0);
  await viewer.locator('.document-surface .math-annotatable').first().click();
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
    page.getByRole('button', { name: 'Collapse sidebar' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
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
      .locator('.document-surface')
      .getByRole('heading', { name: 'Model', exact: true }),
  ).toBeInViewport();
  await expect
    .poll(() => page.locator('.document-layout').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.screenshot({
    path: 'test-results/workspace-mobile.png',
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await other.close();
});
