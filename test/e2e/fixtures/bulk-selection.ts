import { expect, type Locator, type Page } from '@playwright/test';

/**
 * BulkActionBar を e2e で幾何検証するための導線ヘルパ (bdboard-53my)。
 *
 * bdboard-h4xs.11 では flex 折り返しでカスタム延期行を独立行にする CSS を入れたが、
 * jsdom は flex の折り返しを計算しないためユニットテストでは幾何を測れない。
 * また従来の e2e フィクスチャには複数選択して BulkActionBar を出す導線が無かった。
 * このモジュールがその欠落を埋める。
 */

/** test/fixtures/bd/bdboard.list.json の open チケット（hideDone=true 既定で表示される）。 */
export const OPEN_FIXTURE_TICKET_IDS = [
  'bdboard-3tw',
  'bdboard-3tw.8',
  'bdboard-3tw.7',
  'bdboard-3tw.6',
  'bdboard-3tw.5',
  'bdboard-3tw.4',
  'bdboard-3tw.10',
  'bdboard-3tw.9',
] as const;

/** 既定の複数選択用ペア（smoke.spec.ts 等と同じフィクスチャ由来）。 */
export const DEFAULT_BULK_SELECTION_IDS = ['bdboard-3tw.8', 'bdboard-3tw.7'] as const;

function bulkCheckboxForTicket(page: Page, ticketId: string): Locator {
  // merged ビューでは各 ID は1枚。split ではレーンごとに重複しうるので article 内に限定する。
  return page
    .locator('article', { has: page.locator('.card-id', { hasText: ticketId }) })
    .locator('.card-bulk-checkbox input[type="checkbox"]')
    .first();
}

/**
 * 指定チケット ID のカードチェックボックスを on にする。
 * 1件以上 check されると BulkActionBar が描画される。
 */
export async function selectTickets(page: Page, ticketIds: readonly string[]): Promise<void> {
  for (const ticketId of ticketIds) {
    const checkbox = bulkCheckboxForTicket(page, ticketId);
    await expect(checkbox).toBeVisible({ timeout: 15_000 });
    await checkbox.check();
  }
}

/** `.bulk-action-bar` が可視になるまで待つ。 */
export async function waitForBulkActionBar(page: Page): Promise<Locator> {
  const bar = page.locator('.bulk-action-bar');
  await expect(bar).toBeVisible({ timeout: 15_000 });
  return bar;
}

/**
 * BulkActionBar 内の延期期間 select を `custom` に切り替え、
 * date 入力が現れるまで待つ。詳細パネル側の同名 select とは `.bulk-action-bar` でスコープする。
 */
export async function setBulkDeferPeriodCustom(page: Page): Promise<Locator> {
  const bar = page.locator('.bulk-action-bar');
  const deferSelect = bar.locator('select[aria-label="延期期間"]');
  await expect(deferSelect).toBeVisible();
  await deferSelect.selectOption('custom');
  const dateInput = bar.locator('input[type="date"]');
  await expect(dateInput).toBeVisible();
  return dateInput;
}

/**
 * ボードを開き、既定ペアを選択して BulkActionBar を表示し、カスタム延期を選ぶまでの一連。
 */
export async function openBoardWithBulkActionBarCustomDefer(
  page: Page,
  ticketIds: readonly string[] = DEFAULT_BULK_SELECTION_IDS,
): Promise<Locator> {
  await page.goto('/');
  const firstCard = page.locator('article').first();
  await expect(firstCard).toBeVisible({ timeout: 15_000 });
  await selectTickets(page, ticketIds);
  await waitForBulkActionBar(page);
  await setBulkDeferPeriodCustom(page);
  return page.locator('.bulk-action-bar');
}
