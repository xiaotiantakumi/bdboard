import { expect, test } from '@playwright/test';

/**
 * チャットパネルの最大化 (bdboard-3tw.153) を実ブラウザで確かめる。
 *
 * なぜ vitest では足りないか: 最大化の効き目は CSS に依存している。React が
 * 当てるのはインラインの `width: 100%` だけで、それを実際に画面幅まで広げて
 * いるのは `.chat-panel.is-maximized { max-width: 100% }` による通常時の上限
 * (`min(720px, calc(100vw - 320px))`) の解除。jsdom はスタイルシートを読まない
 * ので、この上書きを丸ごと消しても web のテストは全部グリーンのまま通る
 * (PR#139 レビュー minor-5 で指摘された、確実に生き残るミュータント)。
 * ここは実測できる唯一の層なので、幅そのものを見る。
 */
test.describe('chat panel maximize', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('widens the panel past the drag limit and restores the previous width', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 5_000 });
    const chatButton = page.getByRole('button', { name: 'チャット' });
    await expect(chatButton).toBeVisible({ timeout: 15_000 });
    await chatButton.click();

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

    // 最大化中はビューポート幅いっぱい。上限が外れていなければ 720px で
    // 止まるので、この比較がそのまま CSS の上書きの検証になる。
    const maximizedWidth = await widthOf();
    expect(maximizedWidth).toBeGreaterThan(720);
    expect(maximizedWidth).toBeCloseTo(1280, 0);

    await dialog.getByRole('button', { name: '縮小' }).click();
    expect(await widthOf()).toBeCloseTo(normalWidth, 0);
  });
});
