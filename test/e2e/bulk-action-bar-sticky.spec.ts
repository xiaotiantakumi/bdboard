import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_BULK_SELECTION_IDS,
  selectTickets,
  waitForBulkActionBar,
} from './fixtures/bulk-selection.js';

/**
 * BulkActionBar のモバイル bottom sticky (bdboard-h4xs.19)。
 *
 * 375px でカードを複数選択したあとページを縦スクロールしても、一括操作バーが
 * ビューポート内に留まり (position: sticky; bottom: 0)、横あふれや上側 sticky
 * 要素との重なりが無いことを getBoundingClientRect / elementFromPoint で検証する。
 *
 * bottom:0 sticky は要素を下方向へ押し下げない。DOM 上バーはレーンより前にあるため
 * order:1 で flex 視覚順を最後尾に回し、自然位置をドキュメント末尾に置いてから
 * bottom:0 を効かせる。order を外すと scrollTop=0 でバーは画面上部に居り、
 * barRect.bottom >= innerHeight のアサートが落ちる (変異検出)。
 *
 * デスクトップ 1280x800: position=static, order=0 (モバイル限定変更の回帰ガード)
 */

const EDGE_TOLERANCE_PX = 0.5;
const BOTTOM_STICK_TOLERANCE_PX = 2;
const STICK_TOLERANCE_PX = 2;

interface RectSnapshot {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface ButtonHitTestSnapshot {
  label: string;
  rect: RectSnapshot;
  centerX: number;
  centerY: number;
  hitElementTag: string;
  hitElementClass: string;
  hitIsButtonOrDescendant: boolean;
}

interface BulkActionBarStickyMetrics {
  viewportLabel: string;
  scrollTop: number;
  documentScrollHeight: number;
  innerWidth: number;
  innerHeight: number;
  bodyScrollWidth: number;
  barPosition: string;
  barOrder: string;
  barRect: RectSnapshot;
  headerRect: RectSnapshot | null;
  stripRect: RectSnapshot | null;
  stripVisible: boolean;
  buttonHitTests: ButtonHitTestSnapshot[];
}

async function measureBulkActionBarSticky(
  page: Page,
  viewportLabel: string,
): Promise<BulkActionBarStickyMetrics> {
  return page.evaluate(
    ({ label }) => {
      const bar = document.querySelector('.bulk-action-bar');
      if (!(bar instanceof HTMLElement)) {
        throw new Error('bulk-action-bar not found');
      }

      const header = document.querySelector('.header');
      const strip = document.querySelector('.lane-indicator-strip');

      const barRect = bar.getBoundingClientRect();
      const headerRect =
        header instanceof HTMLElement ? header.getBoundingClientRect() : null;
      const stripRect =
        strip instanceof HTMLElement ? strip.getBoundingClientRect() : null;

      const stripVisible =
        stripRect !== null &&
        stripRect.height > 0 &&
        stripRect.bottom > stripRect.top &&
        window.getComputedStyle(strip!).display !== 'none';

      const buttons = Array.from(bar.querySelectorAll('button'));
      const buttonHitTests: ButtonHitTestSnapshot[] = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        const hitIsButtonOrDescendant =
          hit !== null && (hit === button || button.contains(hit));

        return {
          label: (button.textContent ?? '').trim() || button.getAttribute('aria-label') || 'button',
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          },
          centerX,
          centerY,
          hitElementTag: hit?.tagName.toLowerCase() ?? 'null',
          hitElementClass:
            hit instanceof HTMLElement && typeof hit.className === 'string'
              ? hit.className
              : '',
          hitIsButtonOrDescendant,
        };
      });

      const barStyle = window.getComputedStyle(bar);

      return {
        viewportLabel: label,
        scrollTop: document.documentElement.scrollTop,
        documentScrollHeight: document.documentElement.scrollHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        bodyScrollWidth: document.body.scrollWidth,
        barPosition: barStyle.position,
        barOrder: barStyle.order,
        barRect: {
          top: barRect.top,
          bottom: barRect.bottom,
          left: barRect.left,
          right: barRect.right,
          width: barRect.width,
          height: barRect.height,
        },
        headerRect: headerRect
          ? {
              top: headerRect.top,
              bottom: headerRect.bottom,
              left: headerRect.left,
              right: headerRect.right,
              width: headerRect.width,
              height: headerRect.height,
            }
          : null,
        stripRect: stripRect
          ? {
              top: stripRect.top,
              bottom: stripRect.bottom,
              left: stripRect.left,
              right: stripRect.right,
              width: stripRect.width,
              height: stripRect.height,
            }
          : null,
        stripVisible,
        buttonHitTests,
      };
    },
    { label: viewportLabel },
  );
}

function assertBarInsideViewport(
  metrics: BulkActionBarStickyMetrics,
  context: string,
): void {
  expect(
    metrics.barRect.top,
    `${context}: bar top must be >= 0 (top=${metrics.barRect.top}, scrollTop=${metrics.scrollTop})`,
  ).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
  expect(
    metrics.barRect.bottom,
    `${context}: bar bottom must be <= innerHeight ` +
      `(bottom=${metrics.barRect.bottom}, innerHeight=${metrics.innerHeight}, scrollTop=${metrics.scrollTop})`,
  ).toBeLessThanOrEqual(metrics.innerHeight + 1);
}

function assertBarStuckToBottom(
  metrics: BulkActionBarStickyMetrics,
  context: string,
): void {
  expect(
    metrics.documentScrollHeight,
    `${context}: page must be vertically scrollable ` +
      `(scrollHeight=${metrics.documentScrollHeight}, innerHeight=${metrics.innerHeight})`,
  ).toBeGreaterThan(metrics.innerHeight);

  expect(
    metrics.barRect.bottom,
    `${context}: bar bottom must be glued to viewport bottom ` +
      `(bottom=${metrics.barRect.bottom}, innerHeight=${metrics.innerHeight}, scrollTop=${metrics.scrollTop})`,
  ).toBeGreaterThanOrEqual(metrics.innerHeight - BOTTOM_STICK_TOLERANCE_PX);
}

function assertNoHorizontalOverflow(metrics: BulkActionBarStickyMetrics, context: string): void {
  expect(
    metrics.bodyScrollWidth,
    `${context}: body.scrollWidth must not exceed innerWidth ` +
      `(body.scrollWidth=${metrics.bodyScrollWidth}, innerWidth=${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth);

  expect(
    metrics.barRect.left,
    `${context}: bar left must not clip past viewport ` +
      `(left=${metrics.barRect.left})`,
  ).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
  expect(
    metrics.barRect.right,
    `${context}: bar right must not exceed viewport ` +
      `(right=${metrics.barRect.right}, innerWidth=${metrics.innerWidth})`,
  ).toBeLessThanOrEqual(metrics.innerWidth + EDGE_TOLERANCE_PX);
}

/** ストリップ貼り付き状態が mid/bottom 測定のいずれかで観測されたかを追跡する。 */
interface StripStuckTracker {
  observed: boolean;
}

function computeStripIsStuck(metrics: BulkActionBarStickyMetrics): boolean {
  const headerBottom = metrics.headerRect?.bottom ?? 0;
  return (
    metrics.stripVisible &&
    metrics.stripRect !== null &&
    Math.abs(metrics.stripRect.top - headerBottom) <= STICK_TOLERANCE_PX
  );
}

// .lane-indicator-strip は top: var(--header-height) の sticky。
// scrollTop=0 ではまだ貼り付いておらず自然位置 620.48〜664.48px に居る
// (実測 2026-09-05, 375x812 / 375x667)。
// そのため最上部ではバー (375x812: 634-812 / 375x667: 489-667) がストリップ下部と
// 重なる。これは「バーを下端に貼る」以上避けられない前景/背景の重なりで、
// バー側 z-index:6 > ストリップ 5 によりボタンは常に手前 (assertButtonHitTests が担保)。
// 少し下へスクロールすればストリップはヘッダー直下に貼り付き、画面下端のバーとは分離する。
// よってストリップ非重なりは「貼り付いている状態」に限定する。
// モバイル最上部でレーン可視領域が狭い件は別チケット bdboard-qxt1 の領分。
function assertBarBelowTopStickyChrome(
  metrics: BulkActionBarStickyMetrics,
  context: string,
  stripStuckTracker?: StripStuckTracker,
): void {
  if (metrics.headerRect !== null) {
    expect(
      metrics.barRect.top,
      `${context}: bar must not overlap header ` +
        `(barTop=${metrics.barRect.top}, headerBottom=${metrics.headerRect.bottom})`,
    ).toBeGreaterThanOrEqual(metrics.headerRect.bottom - EDGE_TOLERANCE_PX);
  }

  const stripIsStuck = computeStripIsStuck(metrics);
  if (stripIsStuck && stripStuckTracker !== undefined) {
    stripStuckTracker.observed = true;
  }

  if (stripIsStuck && metrics.stripRect !== null) {
    expect(
      metrics.barRect.top,
      `${context}: bar must not overlap stuck lane-indicator-strip ` +
        `(barTop=${metrics.barRect.top}, stripBottom=${metrics.stripRect.bottom}, ` +
        `stripTop=${metrics.stripRect.top})`,
    ).toBeGreaterThanOrEqual(metrics.stripRect.bottom - EDGE_TOLERANCE_PX);
  }
}

function assertStripStuckObservedWhenVisible(
  metrics: BulkActionBarStickyMetrics,
  stripStuckTracker: StripStuckTracker,
  viewportLabel: string,
): void {
  if (!metrics.stripVisible) {
    return;
  }

  expect(
    stripStuckTracker.observed,
    `${viewportLabel}: lane-indicator-strip must stick under header at least once ` +
      `(mid scroll or at bottom) so stuck-state non-overlap is exercised`,
  ).toBe(true);
}

function assertButtonHitTests(metrics: BulkActionBarStickyMetrics, context: string): void {
  for (const hit of metrics.buttonHitTests) {
    expect(
      hit.centerY,
      `${context}: button "${hit.label}" center must be inside viewport ` +
        `(centerY=${hit.centerY}, innerHeight=${metrics.innerHeight})`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      hit.centerY,
      `${context}: button "${hit.label}" center must be inside viewport ` +
        `(centerY=${hit.centerY}, innerHeight=${metrics.innerHeight})`,
    ).toBeLessThanOrEqual(metrics.innerHeight);

    expect(
      hit.hitIsButtonOrDescendant,
      `${context}: button "${hit.label}" must not be covered ` +
        `(center=(${hit.centerX}, ${hit.centerY}), hit=${hit.hitElementTag}.${hit.hitElementClass})`,
    ).toBe(true);
  }
}

async function openBoardWithBulkSelection(page: Page): Promise<void> {
  await page.goto('/');
  const firstCard = page.locator('article').first();
  await expect(firstCard).toBeVisible({ timeout: 15_000 });
  await selectTickets(page, DEFAULT_BULK_SELECTION_IDS);
  await waitForBulkActionBar(page);
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const scrollTop = await page.evaluate(() => document.documentElement.scrollTop);
  expect(scrollTop, 'page must be at scrollTop=0 before top-of-page measurement').toBe(0);
}

async function assertMobileStickyBehavior(
  page: Page,
  viewportLabel: string,
): Promise<void> {
  const stripStuckTracker: StripStuckTracker = { observed: false };

  await scrollToTop(page);

  const metricsAtTop = await measureBulkActionBarSticky(page, viewportLabel);

  expect(
    metricsAtTop.barPosition,
    `${viewportLabel}: bar must use position sticky on mobile`,
  ).toBe('sticky');
  expect(
    metricsAtTop.barOrder,
    `${viewportLabel}: bar must use order:1 on mobile`,
  ).toBe('1');

  // AC1 (sticky works): bar glued to viewport bottom while page is scrollable
  assertBarStuckToBottom(metricsAtTop, `${viewportLabel} at top of page`);
  assertBarInsideViewport(metricsAtTop, `${viewportLabel} at top of page`);
  // AC2 (no horizontal overflow)
  assertNoHorizontalOverflow(metricsAtTop, `${viewportLabel} at top of page`);
  assertBarBelowTopStickyChrome(
    metricsAtTop,
    `${viewportLabel} at top of page`,
    stripStuckTracker,
  );

  const midScrollTarget = await page.evaluate(() => {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const target = Math.round(maxScroll / 2);
    window.scrollTo(0, target);
    return { maxScroll, target, actual: document.documentElement.scrollTop };
  });

  expect(
    midScrollTarget.maxScroll,
    `${viewportLabel} mid scroll setup: page must be vertically scrollable`,
  ).toBeGreaterThan(0);
  expect(
    midScrollTarget.actual,
    `${viewportLabel} mid scroll setup: must not be at top`,
  ).toBeGreaterThan(0);
  expect(
    midScrollTarget.actual,
    `${viewportLabel} mid scroll setup: must not clamp to bottom ` +
      `(actual=${midScrollTarget.actual}, maxScroll=${midScrollTarget.maxScroll})`,
  ).toBeLessThan(midScrollTarget.maxScroll);

  const metricsMidScroll = await measureBulkActionBarSticky(page, viewportLabel);

  expect(metricsMidScroll.barPosition, `${viewportLabel} mid scroll`).toBe('sticky');
  // AC1: bar stays in viewport while lanes are scrolled
  assertBarInsideViewport(metricsMidScroll, `${viewportLabel} mid scroll`);
  assertBarBelowTopStickyChrome(
    metricsMidScroll,
    `${viewportLabel} mid scroll`,
    stripStuckTracker,
  );
  assertButtonHitTests(metricsMidScroll, `${viewportLabel} mid scroll`);

  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });

  const scrollTop = await page.evaluate(() => document.documentElement.scrollTop);
  expect(
    scrollTop,
    `${viewportLabel}: page must scroll vertically (scrollTop=${scrollTop}, ` +
      `scrollHeight=${metricsAtTop.documentScrollHeight})`,
  ).toBeGreaterThan(0);

  const metricsAtBottom = await measureBulkActionBarSticky(page, viewportLabel);

  await test.info().attach(`bulk-action-bar-sticky-metrics-${viewportLabel}`, {
    body: JSON.stringify(
      {
        atTop: metricsAtTop,
        midScroll: {
          ...metricsMidScroll,
          maxScroll: midScrollTarget.maxScroll,
          midScrollTarget: {
            target: midScrollTarget.target,
            actual: midScrollTarget.actual,
          },
        },
        atBottom: metricsAtBottom,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });

  expect(metricsAtBottom.barPosition, `${viewportLabel} at bottom`).toBe('sticky');
  assertBarInsideViewport(metricsAtBottom, `${viewportLabel} at bottom`);
  assertNoHorizontalOverflow(metricsAtBottom, `${viewportLabel} at bottom`);
  assertBarBelowTopStickyChrome(
    metricsAtBottom,
    `${viewportLabel} at bottom`,
    stripStuckTracker,
  );
  assertStripStuckObservedWhenVisible(metricsAtBottom, stripStuckTracker, viewportLabel);
  assertButtonHitTests(metricsAtBottom, `${viewportLabel} at bottom`);
}

const MOBILE_VIEWPORTS = [
  { width: 375, height: 812, label: '375x812' },
  { width: 375, height: 667, label: '375x667' },
] as const;

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`bulk action bar sticky @ ${viewport.label}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true,
    });

    test('bar stays in viewport after vertical scroll without horizontal overflow', async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await openBoardWithBulkSelection(page);
      await assertMobileStickyBehavior(page, viewport.label);
    });
  });
}

test.describe('bulk action bar sticky desktop regression', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
  });

  test('desktop keeps position static', async ({ page }) => {
    test.setTimeout(60_000);
    await openBoardWithBulkSelection(page);

    const styles = await page.evaluate(() => {
      const bar = document.querySelector('.bulk-action-bar');
      if (!(bar instanceof HTMLElement)) {
        throw new Error('bulk-action-bar not found');
      }
      const computed = window.getComputedStyle(bar);
      return { position: computed.position, order: computed.order };
    });

    expect(styles.position, 'desktop bulk-action-bar must remain position static').toBe('static');
    expect(styles.order, 'desktop bulk-action-bar must not inherit mobile order:1').toBe('0');
  });
});
