import { expect, test } from '@playwright/test';

// Kept in sync with test/fixtures/bd/bdboard.list.json, which
// test/e2e/fixtures/bin/bd (the stub bd CLI) serves verbatim for the `list`
// subcommand. bdboard-3tw.8 is `status: "open"` with its one blocker already
// closed, so it lands in a lane that is visible under the default
// hideDone=true filter (see src/domain/readiness.ts / web/src/App.tsx).
const TICKET_ID = 'bdboard-3tw.8';
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';
const TICKET_DESCRIPTION_SNIPPET = 'Fixture description for bdboard-3tw.8';

test.describe('bdboard smoke', () => {
  test('GET /api/health reports ok', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/api/health`);
    expect(res.status()).toBe(200);

    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  test('board renders a fixture ticket and its detail panel shows the description', async ({
    page,
  }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible();
    await expect(card.locator('.card-id')).toHaveText(TICKET_ID);

    await card.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: TICKET_TITLE })).toBeVisible();
    await expect(dialog.getByText(TICKET_DESCRIPTION_SNIPPET)).toBeVisible();
  });
});
