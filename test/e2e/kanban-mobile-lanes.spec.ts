import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile kanban lane height cap and lane indicator visibility (bdboard-h4xs.3).
 *
 * 証明している:
 * - 統合ビューの .lane 高さ上限 (CSS を戻すと実際に落ちる: height > 812)
 * - 分割ビューでも同じ上限が効き、既存挙動を壊さない (AC3)
 * - 全縦スクロール位置で .lane-indicator-strip が viewport (0–812) 内に収まる (AC2)
 * - 全縦スクロール位置で strip が .header の背面に潜らない
 *   (--lane-indicator-sticky-top が可変高ヘッダー直下を指している)
 *
 * 証明していない:
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

  async function expectStripVisibleAtAllScrollPositions(page: Page) {
    const maxScrollY = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    );

    const indicator = page.locator('.lane-indicator-strip');
    const header = page.locator('.header');

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
      expectBoxInsideViewport(indicatorBox!, VIEWPORT_HEIGHT, scrollY);

      const headerBox = await header.boundingBox();
      expect(
        headerBox,
        `header should have a bounding box at scrollY=${scrollY}`,
      ).not.toBeNull();
      expectStripNotBehindHeader(indicatorBox!, headerBox!, scrollY);
    }
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
