import { expect, test } from '@playwright/test';

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
  test.use({ viewport: { width: 375, height: 812 } });

  test('adding the clear button does not grow the toggle row', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

    const snapshot = async () =>
      page.evaluate(() => {
        const row = document.querySelector('.board-filter-toggle-row');
        const clear = document.querySelector('.board-filter-toggle-clear');
        const strip = document.querySelector('.lane-indicator-strip');
        const clearRect = clear === null ? null : clear.getBoundingClientRect();
        return {
          rowHeight: row === null ? null : row.getBoundingClientRect().height,
          contentStart: strip === null ? null : strip.getBoundingClientRect().top,
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
  });
});
