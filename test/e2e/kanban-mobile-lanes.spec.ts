import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile kanban lane height cap and lane indicator visibility (bdboard-h4xs.3).
 *
 * 証明している:
 * - 統合ビューの .lane 高さ上限 (CSS を戻すと実際に落ちる: height > viewport)
 * - 分割ビューでも同じ上限が効き、既存挙動を壊さない (AC3)
 * - sticky 発火後、strip が --header-height (可変高ヘッダー直下) に張り付き viewport 内に収まる (AC2)
 * - ページ最下部までスクロールした状態でも strip が header 直下に張り付き viewport 内に収まる
 * - 全縦スクロール位置で strip が .header の背面に潜らない
 *   (書き込み元は useHeaderHeightVar.ts)
 *
 * 証明していない:
 * - scrollY=0 等、sticky 未発火時に strip が viewport 内にあること
 *   (初期表示での可視性は保証しない。sticky で追随するため)
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
   *
   * 942px 失敗報告 (strip bottom) の内訳は未確認 — 「古い dist = ヘッダー402px版」なら
   * bottom=785.47 のはずで差 157.47px の出所は不明 (報告者環境に strip より上の追加要素が
   * あったと推定されるが再現していない)。再現手順: npx playwright test は web/dist を
   * 再ビルドしないので、計測前に npm run build:web が必要。
   *
   * activationScrollY (= stripDocTop - headerHeight) はヘッダー高 H に依存する。maxScrollY
   * (= pageHeight - innerHeight) は bdboard-knrx 以降 H に依存しない (レーン上限が
   * --header-height を引くのでヘッダー項が打ち消える) ので、ヘッダーが縮むと
   * activationScrollY だけが上がり、maxScrollY < activationScrollY となって strip が
   * 一度も stuck せずテストが空振りしうる。
   * header-sticky.spec.ts の ensurePageScrollable と同型で、.lanes-scroll-region 末尾に
   * flex-shrink:0 の spacer を足して縦スクロール余裕を確保してから検証する (.app ではなく
   * region — .app に足すと strip ごと画面外へ流れる)。
   *
   * 2026-09-05 実測 (npm run build:web 後、viewport 375x812):
   *   spacer 前: headerH=193 activationScrollY=387.48 maxScrollY=396 margin=8.52
   *   spacer 後: headerH=193 activationScrollY=387.48 maxScrollY=2020 margin=1632.52
   *   stuck 時 |stripTop - headerBottom|=0.00、laneHeights=[552,552,552,552] (spacer 前後不変)
   */
  async function expectStripVisibleAtAllScrollPositions(page: Page) {
    const indicator = page.locator('.lane-indicator-strip');
    const header = page.locator('.header');

    await page.evaluate(() => window.scrollTo(0, 0));

    const viewportHeight = await page.evaluate(() => window.innerHeight);

    const measureScrollMetrics = () =>
      page.evaluate(() => {
        const strip = document.querySelector('.lane-indicator-strip');
        const headerEl = document.querySelector('.header');
        if (!strip || !headerEl) {
          throw new Error('.lane-indicator-strip or .header not found');
        }
        const stripRect = strip.getBoundingClientRect();
        const headerRect = headerEl.getBoundingClientRect();
        const stripDocTop = stripRect.top + window.scrollY;
        const headerHeight = headerRect.height;
        const activationScrollY = stripDocTop - headerHeight;
        const maxScrollY = Math.max(
          0,
          document.documentElement.scrollHeight - window.innerHeight,
        );
        return { activationScrollY, maxScrollY };
      });

    await page.evaluate(() => {
      const region = document.querySelector('.lanes-scroll-region');
      if (!region) throw new Error('.lanes-scroll-region not found');
      const spacer = document.createElement('div');
      spacer.dataset.testid = 'e2e-strip-sticky-spacer';
      spacer.style.height = '200vh';
      spacer.style.flexShrink = '0';
      region.appendChild(spacer);
    });

    const { activationScrollY, maxScrollY } = await measureScrollMetrics();

    expect(
      maxScrollY - activationScrollY,
      'strip sticky を発火させるだけの縦スクロール量が必要（レイアウト変更で満たせなくなったらここで気付く）',
    ).toBeGreaterThan(100);

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
      const isLastStep = step === SCROLL_CHECK_STEPS;
      // +1: expectStripNotBehindHeader の headerBottom - 1 と対でサブピクセル丸めを吸収
      const isStuck = indicatorBox!.y <= headerBottom + 1;

      if (isStuck) {
        expect(
          Math.abs(indicatorBox!.y - headerBottom),
          `strip should stick flush to header bottom at scrollY=${scrollY} ` +
            `(stripTop=${indicatorBox!.y}, headerBottom=${headerBottom})`,
        ).toBeLessThanOrEqual(1);
        expectBoxInsideViewport(indicatorBox!, viewportHeight, scrollY);
      }
      expectStripNotBehindHeader(indicatorBox!, headerBox!, scrollY);

      if (isLastStep) {
        expect(
          Math.abs(indicatorBox!.y - headerBottom),
          `strip should stick flush to header bottom at max scroll scrollY=${scrollY} ` +
            `(stripTop=${indicatorBox!.y}, headerBottom=${headerBottom})`,
        ).toBeLessThanOrEqual(1);
        expectBoxInsideViewport(indicatorBox!, viewportHeight, scrollY);
      }
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
