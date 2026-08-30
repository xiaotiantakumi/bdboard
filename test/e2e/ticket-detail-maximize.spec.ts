import { expect, test } from '@playwright/test';

/**
 * チケット詳細パネルの最大化 (bdboard-0hcx) を実ブラウザで確かめる。
 *
 * なぜ vitest では足りないか: chat-maximize.spec.ts と同じ理由。最大化の効き目は
 * CSS に依存していて、React が当てるのはインラインの `width: 100%` だけ。実際に
 * 画面幅まで広げているのは `.detail-panel.resizable-side-panel.is-maximized` に
 * よる通常時の上限 (`min(720px, calc(100vw - 320px))`) の解除で、jsdom は
 * スタイルシートを読まないので、この上書きを丸ごと消しても web のテストは全部
 * グリーンのまま通る (実測: 76/76 pass)。
 *
 * PR#139 で ChatPanel について同じ指摘が出て chat-maximize.spec.ts が生まれた。
 * 詳細パネルへ機能を移植するなら、この層も一緒に移植しないと同じ穴が空く
 * (PR#242 opus レビュー major-2)。
 */
// smoke.spec.ts と同じフィクスチャチケット。test/e2e/fixtures/bin/bd (スタブ bd
// CLI) が list に対してこれを返し、既定フィルタ (hideDone=true) でも見えるレーンに
// 入る。`.first()` のような順序依存のセレクタは使わない。
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';

test.describe('ticket detail panel maximize', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('widens the panel past the drag limit and restores the previous width', async ({
    page,
  }) => {
    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const widthOf = async (): Promise<number> => {
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      return box!.width;
    };

    // 通常時はドラッグ上限 (MAX_WIDTH = 720px) を超えない。
    const normalWidth = await widthOf();
    expect(normalWidth).toBeLessThanOrEqual(720);

    await dialog.getByRole('button', { name: '最大化' }).click();

    // 最大化中はビューポート幅いっぱい。上限が外れていなければ 720px で止まる
    // ので、この比較がそのまま CSS の上書きの検証になる。
    const maximizedWidth = await widthOf();
    expect(maximizedWidth).toBeGreaterThan(720);
    expect(maximizedWidth).toBeCloseTo(1280, 0);

    await dialog.getByRole('button', { name: '縮小' }).click();
    expect(await widthOf()).toBeCloseTo(normalWidth, 0);
  });
});

/**
 * モバイルではパネルが既に 100vw なので最大化に意味が無く、`.detail-maximize` を
 * `display: none` にしている (index.css の @media)。これも CSS でしか効いていない
 * ので、クラス名を落とす変異は web のテストでは検知できない (実測: 77/77 pass)。
 */
test.describe('ticket detail panel maximize on mobile', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('hides the maximize control', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.tap();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // 「閉じる」は見えている = パネル自体は開いている、という対照。
    await expect(dialog.getByRole('button', { name: '閉じる' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '最大化' })).toBeHidden();
  });
});
