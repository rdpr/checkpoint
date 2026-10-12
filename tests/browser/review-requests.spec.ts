import { choose } from './controls';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Artifact, ReviewRequest, Reviewer } from '../../shared/types';

async function expandRequests(page: Page) {
  await page.locator('.request-row > details > summary').first().waitFor();
  for (const detail of await page.locator('.request-row > details').all()) {
    if (!(await detail.getAttribute('open'))) {
      // Empty-string attributes also indicate an open details element.
      if (!(await detail.evaluate((e) => (e as HTMLDetailsElement).open)))
        await detail.locator('summary').click();
    }
  }
}

test.use({ actionTimeout: 15000 });
test('agent and teammate request exact revisions, reviewers complete rounds, and renewals preserve history', async ({
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
    const response = await request.post(`/api${path}`, {
      headers: { Origin: origin },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const status = await (await page.request.get('/api/auth/status')).json();
  const { user } = await send(
    page.request,
    status.needsSetup ? '/auth/setup' : '/auth/login',
    { name: 'Alex Morgan', email: 'alex@example.test', password },
  );
  const workspace = await send(page.request, '/workspaces', {
    name: 'Review handoffs',
  });
  const key = await send(page.request, `/workspaces/${workspace.id}/tokens`, {
    name: 'Implementation agent',
    scope: 'write',
  });
  const client = new Client({ name: 'browser-handoff', version: '1' });
  const other = await browser.newContext();
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${key.token}` } },
      }),
    );
    const call = async <T>(
      name: string,
      args: Record<string, unknown>,
    ): Promise<T> => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
      return (result.structuredContent as { result: T }).result;
    };
    const reviewers = await call<Reviewer[]>('list_reviewers', {
      workspaceId: workspace.id,
    });
    expect(reviewers.some((r) => r.id === user.id)).toBeTruthy();
    const doc = await call<Artifact>('create_artifact', {
      workspaceId: workspace.id,
      path: 'handoff/rollout.md',
      body: '# Rollout\n\nShip the initial release.',
    });
    const first = await call<ReviewRequest>('request_review', {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      reviewerId: user.id,
      message: 'Check the rollout before implementation.',
    });
    const requests = () =>
      call<ReviewRequest[]>('list_review_requests', {
        workspaceId: workspace.id,
        artifactId: doc.id,
      });
    const url = `/?workspace=${workspace.id}&artifact=${doc.id}`;
    await page.goto(`/?workspace=${workspace.id}&view=reviews`);
    await expandRequests(page);
    const queue = page.getByRole('article', {
      name: 'Review request for handoff/rollout.md',
      exact: true,
    });
    await expect(queue).toContainText('Implementation agent (for Alex Morgan)');
    await queue
      .getByRole('button', { name: 'Open requested revision' })
      .click();
    await expect(page).toHaveURL(new RegExp(`request=${first.id}`));
    await expect(
      page
        .locator('.artifact-surface')
        .getByRole('heading', { name: 'Rollout', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Finish review', exact: true })
      .click();
    await page
      .getByLabel('Review note (optional)')
      .fill('Add a rollback procedure.');
    await page
      .getByRole('button', { name: 'Request changes', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Artifact review', exact: true }),
    ).toContainText('Changes requested');
    expect((await requests()).find((r) => r.id === first.id)?.status).toBe(
      'changes_requested',
    );
    const next = await call<Artifact>('update_artifact', {
      artifactId: doc.id,
      expectedRevisionId: doc.currentRevisionId,
      body: '# Rollout\n\nShip the initial release.\n\nRollback to the previous deployment on failure.',
    });
    const second = await call<ReviewRequest>('renew_review_request', {
      requestId: first.id,
      expectedVersion: first.version,
      expectedRevisionId: next.currentRevisionId,
      message: 'Rollback added; please review the delta.',
    });
    await page.getByRole('button', { name: 'My reviews', exact: true }).click();
    await expandRequests(page);
    await expect(
      queue.getByText('Rollback added; please review the delta.', {
        exact: true,
      }),
    ).toBeVisible();
    await queue
      .getByRole('button', { name: 'Open requested revision' })
      .click();
    await expect(page.getByLabel('Comparison baseline')).toHaveText(
      /Revision 1/,
    );
    await expect(page.locator('.revision-diff')).toContainText(
      'Rollback to the previous deployment',
    );
    await page.reload();
    await expect(page.getByLabel('Comparison baseline')).toHaveText(
      /Revision 1/,
    );
    await page
      .getByRole('button', { name: 'Finish review', exact: true })
      .click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Artifact review', exact: true }),
    ).toContainText('Approved');
    expect((await requests()).find((r) => r.id === second.id)?.status).toBe(
      'approved',
    );

    const invite = await send(
      page.request,
      `/workspaces/${workspace.id}/invitations`,
      { role: 'editor' },
    );
    await send(other.request, '/auth/register', {
      name: 'Jordan Lee',
      email: 'jordan-requests@example.test',
      password,
      invitation: invite.token,
    });
    const teammate = await other.newPage();
    teammate.on('pageerror', (e) => errors.push(e.message));
    await teammate.goto(url);
    await teammate
      .getByRole('button', { name: 'Request review', exact: true })
      .click();
    const modal = teammate.getByRole('dialog', {
      name: 'Request review',
      exact: true,
    });
    await choose(
      modal.getByLabel('Reviewer', { exact: true }),
      'Alex Morgan (owner)',
    );
    await modal
      .getByLabel('Review message (optional)')
      .fill('Verify the final rollout checklist.');
    const third = await call<Artifact>('update_artifact', {
      artifactId: doc.id,
      expectedRevisionId: next.currentRevisionId,
      body: next.revision.body + '\n\nRun the checklist before deployment.',
    });
    await expect(
      modal.getByText('A newer revision is available.', { exact: false }),
    ).toBeVisible({ timeout: 12000 });
    await expect(
      modal.getByRole('button', { name: 'Send review request' }),
    ).toBeDisabled();
    await expect(modal.getByLabel('Review message (optional)')).toHaveValue(
      'Verify the final rollout checklist.',
    );
    await modal
      .getByRole('button', { name: 'Read latest revision', exact: true })
      .click();
    await teammate.reload();
    await teammate
      .getByRole('button', { name: 'Resume request draft', exact: true })
      .click();
    await expect(modal.getByLabel('Review message (optional)')).toHaveValue(
      'Verify the final rollout checklist.',
    );
    await expect(modal.getByLabel('Reviewer', { exact: true })).toHaveText(
      /Alex Morgan/,
    );
    await modal
      .getByRole('button', {
        name: 'Use request for revision 3',
        exact: true,
      })
      .click();
    await modal.getByRole('button', { name: 'Send review request' }).click();
    await expect(modal).not.toBeVisible();
    await teammate
      .getByRole('button', { name: 'My reviews', exact: true })
      .click();
    await teammate
      .getByRole('button', { name: 'Requested by me', exact: true })
      .click();
    await expandRequests(teammate);
    await expect(teammate.locator('.review-queue')).toContainText(
      'Waiting for review',
    );
    await page.getByRole('button', { name: 'My reviews', exact: true }).click();
    await expandRequests(page);
    await expect(queue).toContainText('Requested by Jordan Lee');
    await queue
      .getByRole('button', { name: 'Open requested revision' })
      .click();
    await expect(page.getByLabel('Comparison baseline')).toHaveText(
      /Revision 2/,
    );
    await page
      .getByRole('button', { name: 'Finish review', exact: true })
      .click();
    const fourth = await call<Artifact>('update_artifact', {
      artifactId: doc.id,
      expectedRevisionId: third.currentRevisionId,
      body: third.revision.body + '\n\nRecord the deployment outcome.',
    });
    await expect(
      page.getByText('Outdated: newer changes are available', {
        exact: false,
      }),
    ).toBeVisible({ timeout: 12000 });
    await expect(
      page.getByRole('button', { name: 'Approve', exact: true }),
    ).toBeDisabled();
    await expect(page.locator('.revision-diff')).not.toContainText(
      'Record the deployment outcome.',
    );
    await expect(
      teammate.getByRole('button', {
        name: 'Request latest revision',
        exact: true,
      }),
    ).toBeVisible({ timeout: 12000 });
    await teammate
      .getByRole('button', { name: 'Request latest revision', exact: true })
      .click();
    await expandRequests(teammate);
    await expect(teammate.locator('.review-queue')).toContainText('Revision 4');
    await page.getByRole('button', { name: 'Keep draft for later' }).click();
    await page.getByRole('button', { name: 'My reviews', exact: true }).click();
    await expandRequests(page);
    await expect(queue).toContainText('Revision 4');
    await queue
      .getByRole('button', { name: 'Open requested revision' })
      .click();
    await expect(page.locator('.revision-diff')).toContainText(
      'Record the deployment outcome.',
    );
    await page.getByRole('button', { name: 'Resume review draft' }).click();
    await page
      .getByRole('button', { name: 'Use note for revision 4', exact: true })
      .click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Artifact review', exact: true }),
    ).toContainText('Approved');
    const rounds = await requests();
    expect(
      rounds.find((r) => r.revisionId === fourth.currentRevisionId)?.status,
    ).toBe('approved');
    expect(
      rounds.find((r) => r.revisionId === third.currentRevisionId)?.status,
    ).toBe('superseded');
    await teammate
      .getByRole('button', { name: 'Completed', exact: true })
      .click();
    const approvedRow = teammate.locator('.request-row').filter({
      has: teammate.locator('.pill').filter({ hasText: /^Approved$/ }),
    });
    await expect(approvedRow).toHaveCount(1, { timeout: 12000 });
    await approvedRow.locator('summary').click();
    await approvedRow
      .getByRole('button', { name: 'Request review again', exact: true })
      .click();
    await teammate
      .getByRole('button', { name: 'Requested by me', exact: true })
      .click();
    await expandRequests(teammate);
    await teammate
      .getByRole('button', { name: 'Cancel request', exact: true })
      .click();
    await expect(
      teammate.getByText('No review requests from you yet.'),
    ).toBeVisible();
    await teammate
      .getByRole('button', { name: 'Completed', exact: true })
      .click();
    await expect(teammate.locator('.review-queue')).toContainText('Cancelled');
    await teammate.screenshot({
      path: 'test-results/my-reviews-desktop.png',
      fullPage: true,
    });
    await teammate.setViewportSize({ width: 390, height: 844 });

    await teammate.screenshot({
      path: 'test-results/my-reviews-mobile.png',
      fullPage: true,
    });
    expect(
      await teammate.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    await other.close();
  }
});
