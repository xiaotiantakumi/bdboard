import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile kanban lane height cap and lane indicator visibility (bdboard-h4xs.3).
 *
 * 証明している:
 * - 統合ビューの .lane 高さ上限 (CSS を戻すと実際に落ちる: height > viewport)
 * - 分割ビューでも同じ上限が効き、既存挙動を壊さない (AC3)
 * - sticky 発火後の全縦スクロール位置で .lane-indicator-strip が viewport 内に収まる (AC2)
 * - 全縦スクロール位置で strip が .header の背面に潜らない
 *   (--header-height が可変高ヘッダー直下を指している; 書き込み元は useHeaderHeightVar.ts)
 *
 * 証明していない:
 * - scrollY=0 等、sticky 未発火時に strip が viewport 内にあること
 *   (未発火時は通常フローで strip はヘッダー・バナー等の下にあり viewport 外に居るのが正しい)
 * - position: sticky の発火そのもの (header-sticky.spec.ts が担当)
 */
test.describe('kanban mobile lanes', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  const VIEWPORT_HEIGHT = 812;
  const SCROLL_CHECK_STEPS = 8;

  function expectBoxInsideViewport(
    box: { x: number; y: number; width: number; height: number },
    viewportHeight: number,
    scrollY: number,
  ) {
    expect(
      box.y,
      `strip top should be >= 0 at scrollY=${scrollY}`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      box.y + box.height,
      `strip bottom should be <= ${viewportHeight} at scrollY=${scrollY}`,
    ).toBeLessThanOrEqual(viewportHeight);
  }

  function expectStripNotBehindHeader(
    stripBox: { x: number; y: number; width: number; height: number },
    headerBox: { x: number; y: number; width: number; height: number },
    scrollY: number,
  ) {
    const headerBottom = headerBox.y + headerBox.height;
    expect(
      stripBox.y,
      `strip top should be at or below header bottom at scrollY=${scrollY} ` +
        `(stripTop=${stripBox.y}, headerTop=${headerBox.y}, headerBottom=${headerBottom})`,
    ).toBeGreaterThanOrEqual(headerBottom - 1);
  }

  /**
   * .lane-indicator-strip は position:sticky; top:var(--header-height) なので、
   * ページが strip の自然位置を超えてスクロールされるまで viewport 内に留まらない。
   * 旧実装は scrollY=0 も含め全位置で「strip bottom <= viewport」を要求していたが、
   * それは sticky とは無関係で strip より上の要素高さ (ヘッダー+バナー等) だけで決まる。
   * 実測: ヘッダー402px版では scrollY=0 の strip bottom=785px で 812 まで余裕26.5px、
   * PR#304 でヘッダー193pxに圧縮されて 576px になりたまたま通るようになっただけ。
   * 942px 失敗は web/dist 再ビルド無しの単独実行で古い dist (高ヘッダー) が残っていたため。
   *
   * activationScrollY による事前アサーション (maxScrollY >= activationScrollY) は採用しない。
   * 実測 margin (= maxScrollY - activationScrollY) はわずか 8.5px で、ヘッダー高が 9px
   * 縮むだけで maxScrollY が同量減り落ちる (ヘッダーはテキスト含みでフォント/OS 依存)。
   * 代わりにページ最下部までスクロールした状態で strip が viewport 内にあることを検証する。
   * 最下部では stuck 時 stripTop ≈ headerBottom、bottom ≈ headerBottom + stripHeight で
   * viewport 812 に対し約 575px の余裕があり、レイアウト微小変動に強い。
   */
  async function expectStripVisibleAtAllScrollPositions(page: Page) {
    const indicator = page.locator('.lane-indicator-strip');
    const header = page.locator('.header');

    await page.evaluate(() => window.scrollTo(0, 0));

    const viewportHeight = await page.evaluate(() => window.innerHeight);

    const maxScrollY = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    );

    for (let step = 0; step <= SCROLL_CHECK_STEPS; step += 1) {
      const targetScrollY = Math.round((maxScrollY * step) / SCROLL_CHECK_STEPS);
      await page.evaluate((y) => window.scrollTo(0, y), targetScrollY);

      const scrollY = await page.evaluate(() => window.scrollY);
      await expect(indicator, `strip should be visible at scrollY=${scrollY}`).toBeVisible();

      const indicatorBox = await indicator.boundingBox();
      expect(
        indicatorBox,
        `strip should have a bounding box at scrollY=${scrollY}`,
      ).not.toBeNull();

      const headerBox = await header.boundingBox();
      expect(
        headerBox,
        `header should have a bounding box at scrollY=${scrollY}`,
      ).not.toBeNull();

      const headerBottom = headerBox!.y + headerBox!.height;
      const isStuck = indicatorBox!.y <= headerBottom + 1;

      if (isStuck) {
        expectBoxInsideViewport(indicatorBox!, viewportHeight, scrollY);
        expectStripNotBehindHeader(indicatorBox!, headerBox!, scrollY);
      } else {
        // sticky 未発火: viewport 内包は要求しない (通常フローで viewport 外に居るのが正しい)
        expectStripNotBehindHeader(indicatorBox!, headerBox!, scrollY);
      }
    }

    // AC2 本体: 最下部までスクロールした状態で strip が viewport 内に完全に収まること
    await page.evaluate((y) => window.scrollTo(0, y), maxScrollY);
    const bottomScrollY = await page.evaluate(() => window.scrollY);
    await expect(
      indicator,
      `strip should be visible at page bottom scrollY=${bottomScrollY}`,
    ).toBeVisible();

    const bottomIndicatorBox = await indicator.boundingBox();
    expect(
      bottomIndicatorBox,
      `strip should have a bounding box at bottom scrollY=${bottomScrollY}`,
    ).not.toBeNull();

    const bottomHeaderBox = await header.boundingBox();
    expect(
      bottomHeaderBox,
      `header should have a bounding box at bottom scrollY=${bottomScrollY}`,
    ).not.toBeNull();

    expectBoxInsideViewport(bottomIndicatorBox!, viewportHeight, bottomScrollY);
    expectStripNotBehindHeader(bottomIndicatorBox!, bottomHeaderBox!, bottomScrollY);
  }

  test('merged view caps lane height and keeps the lane indicator visible after in-lane scroll', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.lanes-row .lane').first()).toBeVisible({
      timeout: 15_000,
    });

    const lanes = page.locator('.lanes-row .lane');
    const laneCount = await lanes.count();
    expect(laneCount).toBeGreaterThan(0);

    for (let index = 0; index < laneCount; index += 1) {
      const lane = lanes.nth(index);
      const box = await lane.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThanOrEqual(VIEWPORT_HEIGHT);

      const maxHeight = await lane.evaluate((element) => getComputedStyle(element).maxHeight);
      expect(maxHeight).not.toBe('none');
    }

    const laneCards = page.locator('.lanes-row .lane').first().locator('.lane-cards');
    await laneCards.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });

    await expect(page.locator('.lane-indicator-strip')).toBeVisible();

    await expectStripVisibleAtAllScrollPositions(page);
  });

  test('split view keeps the same mobile lane height cap', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.lanes-row .lane').first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: '分割' }).click();
    await expect(page.locator('.board-section .lane').first()).toBeVisible({
      timeout: 15_000,
    });

    const lanes = page.locator('.board-section .lane');
    const laneCount = await lanes.count();
    expect(laneCount).toBeGreaterThan(0);

    for (let index = 0; index < laneCount; index += 1) {
      const lane = lanes.nth(index);
      const box = await lane.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
    }
  });
});
