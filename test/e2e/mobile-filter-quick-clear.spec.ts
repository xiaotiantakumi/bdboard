import { expect, test } from '@playwright/test';

import { installAiQuotaRoute } from './fixtures/mobile-chrome-helpers.js';

/**
 * bdboard-jch5: 折りたたみ時の「解除」ボタンがトグル行の高さを増やさないことを固定する。
 *
 * 単体テストは描画有無しか見られず、既存の mobile-header-compact.spec.ts の
 * ラチェットは既定フィクスチャ (絞り込み非アクティブ) しか通らないため、
 * ボタンが実在する状態でのこの不変条件はどこにも守られていなかった。
 * 行の高さが増えると bdboard-qxt1 が確保した折り返し上の可視領域を食い潰す。
 */
const MIN_TAP_TARGET_PX = 44;

test.describe('mobile collapsed filter quick clear', () => {
  // isMobile / hasTouch まで含めて実機のモバイル文脈に合わせる。viewport だけ絞った
  // 計測は同じ幅でもデスクトップ側のレイアウトを測ってしまい、モバイル固有の
  // はみ出しを取り逃す (bdboard-rccf で実際に取り逃した。同 MINOR-4)。
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('adding the clear button does not grow the toggle row', async ({ page }) => {
    // ヘッダーの AI クォータ表示は実測値でレイアウトが動くので、他のモバイル計測
    // スペックと同じフィクスチャに固定してから測る。
    await installAiQuotaRoute(page);
    await page.goto('/');
    await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

    const snapshot = async () =>
      page.evaluate(() => {
        const row = document.querySelector('.board-filter-toggle-row');
        const clear = document.querySelector('.board-filter-toggle-clear');
        const strip = document.querySelector('.lane-indicator-strip');
        const clearRect = clear === null ? null : clear.getBoundingClientRect();
        const rowRect = row === null ? null : row.getBoundingClientRect();
        const toggle = document.querySelector('.board-filter-toggle');
        return {
          rowHeight: rowRect === null ? null : rowRect.height,
          rowRight: rowRect === null ? null : rowRect.right,
          rowScrollWidth: row === null ? null : row.scrollWidth,
          rowClientWidth: row === null ? null : row.clientWidth,
          toggleRight: toggle === null ? null : toggle.getBoundingClientRect().right,
          contentStart: strip === null ? null : strip.getBoundingClientRect().top,
          clearLeft: clearRect === null ? null : clearRect.left,
          clearWidth: clearRect === null ? null : clearRect.width,
          clearHeight: clearRect === null ? null : clearRect.height,
        };
      });

    const before = await snapshot();
    expect(before.clearHeight, 'no active filter yet, so no quick clear button').toBeNull();
    expect(before.rowHeight).not.toBeNull();

    const toggle = page.locator('.board-filter-toggle');
    await toggle.click();
    const textInput = page
      .locator('#board-filter-panel input[type="search"], #board-filter-panel input[type="text"]')
      .first();
    await expect(textInput).toBeVisible({ timeout: 5_000 });
    // 実際に1件以上ヒットする語であること。0件に絞るとレーンが空になり、
    // .lane-indicator-strip の top が「行の高さ」以外の理由で動いて
    // contentStart の比較が無意味になる。
    await textInput.fill('bdboard');
    await toggle.click();
    await expect(page.locator('.board-filter-toggle-clear')).toBeVisible();

    const after = await snapshot();

    expect(
      after.clearWidth,
      `quick clear button must meet WCAG 2.5.8: ${after.clearWidth}x${after.clearHeight}`,
    ).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    expect(after.clearHeight).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);

    expect(
      after.rowHeight,
      `toggle row grew when the clear button appeared: ${before.rowHeight} -> ${after.rowHeight}`,
    ).toBeCloseTo(before.rowHeight as number, 1);

    expect(
      after.contentStart,
      `content start moved down when the clear button appeared: ` +
        `${before.contentStart} -> ${after.contentStart}`,
    ).toBeCloseTo(before.contentStart as number, 1);

    // 行がはみ出さないこと。トグル本体は width:100% のまま flex の既定 shrink で
    // 縮む (専用の :has() 上書きは要らない — bdboard-jch5 レビュー MINOR-5)。
    // この2本がその「既定で足りる」を実測で固定する。
    expect(
      after.rowScrollWidth,
      `toggle row overflows its own box: ${after.rowScrollWidth} > ${after.rowClientWidth}`,
    ).toBeLessThanOrEqual((after.rowClientWidth as number) + 0.5);
    expect(
      after.toggleRight,
      `toggle overlaps the clear button: toggle.right=${after.toggleRight} ` +
        `clear.left=${after.clearLeft}`,
    ).toBeLessThanOrEqual((after.clearLeft as number) + 0.5);
  });
});
