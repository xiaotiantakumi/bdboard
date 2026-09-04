import { expect, test } from '@playwright/test';

/**
 * gate / lease / merge-slot の e2e 専用 bd fixture がサーバー→UI まで届くことを検証する
 * (bdboard-vr71)。human 一覧は global-setup で別途配線済み。
 */

// smoke.spec.ts / test/fixtures/bd/bdboard.list.json と同期
const TICKET_ID = 'bdboard-3tw.8';
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';

const MERGE_SLOT_HOLDER = 'e2e-fixture-merge-slot-holder';
const MERGE_SLOT_KIND_LABEL = 'マージスロット';
const STALE_LEASE_KIND_LABEL = 'stale lease（heartbeat 途絶）';
const GATE_PRE_SUBMIT_NOTICE =
  'これは質問専用のゲートです。回答するとゲートはクローズされ、ブロックされていたチケットが着手可能になります。';

test.describe('hygiene signals from e2e bd fixtures', () => {
  test('hygiene panel shows merge-slot held status from merge-slot fixture', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await page.getByRole('button', { name: '健全性', exact: true }).click();

    const mergeSlotBadge = page.locator('.hygiene-kind-merge_slot', {
      hasText: MERGE_SLOT_KIND_LABEL,
    });
    await expect(mergeSlotBadge).toBeVisible({ timeout: 15_000 });

    const mergeSlotRow = page.locator('.hygiene-merge-slot-group .hygiene-issue-row');
    await expect(mergeSlotRow).toHaveCount(1);
    await expect(mergeSlotRow.locator('.hygiene-issue-id')).toHaveText(MERGE_SLOT_HOLDER);
    await expect(mergeSlotRow.locator('.hygiene-issue-message')).toContainText('保持中');
  });

  test('hygiene panel shows stale lease from in_progress lease fixture', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    await page.getByRole('button', { name: '健全性', exact: true }).click();

    const staleLeaseBadge = page.locator('.hygiene-kind-stale_lease', {
      hasText: STALE_LEASE_KIND_LABEL,
    });
    await expect(staleLeaseBadge).toBeVisible({ timeout: 15_000 });

    const staleLeaseRow = page.locator('.hygiene-stale-lease-group .hygiene-issue-row', {
      hasText: TICKET_ID,
    });
    await expect(staleLeaseRow).toHaveCount(1);
    await expect(staleLeaseRow.locator('.hygiene-issue-message')).toContainText(
      'lease 失効から',
    );
  });

  test('gate list fixture marks the ticket pending decision as kind gate in detail panel', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.badge-pending-decision')).toHaveText('確認待ち');

    await card.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(GATE_PRE_SUBMIT_NOTICE)).toBeVisible({
      timeout: 15_000,
    });
  });
});
