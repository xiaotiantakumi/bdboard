import { expect, test, type Page } from '@playwright/test';

/**
 * Header position:sticky, horizontal pan, and scroll-padding regressions (bdboard-wdwa).
 *
 * Horizontal bleed is gated by a mobile touch-drag test asserting body { overflow-x: clip }.
 * Removing html overflow-x clipping alone does not restore horizontal pan in this setup, and
 * documentElement.scrollWidth <= innerWidth is not used — when overflow widens the layout
 * viewport both sides grow together (e.g. 1312), so that comparison cannot detect bleed.
 *
 * html { scroll-padding-top: calc(var(--header-height) + var(--lane-strip-height)) }
 * keeps keyboard-focused cards below the sticky header and mobile lane strip when
 * scrollIntoView({ block: 'nearest' }) runs.
 *
 * scroll-padding-top test setup: lanes are max-height capped and scroll internally, so the
 * board fits in the viewport. A top spacer alone lets j reach scrollY > 0, but at max scroll
 * the whole board can sit on-screen — then upward k only moves focus and never scrolls the
 * document unless the focused card's top falls below scroll-padding-top (--header-height).
 * That made upwardScrollCount depend on header height (failed when header shrank 402→193px,
 * bdboard-h4xs.5). A bottom spacer plus explicit scrollTo(maxScrollY) before phase 2 pushes
 * the board above the viewport so k must scroll the document up, exercising scroll-padding-top
 * regardless of --header-height.
 *
 * Lane strip sticky (375×812 measured): phase 1 (j) caps at scrollY≈1348; strip sticks at
 * scrollY≥≈1362 (strip document top ≈1555 − header 193). Strip sticky is never observed in
 * phase 1 — the vacuity guard for sawStripSticky runs after phase 2 (scrollTo maxScrollY, k).
 */

const SCROLL_PROBE_Y = 400;
const HEADER_TOP_TOLERANCE_PX = 2;
const VIEWPORT_OFFSET_TOLERANCE_PX = 1;

async function dispatchTouchDrag(
  page: Page,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps = 8,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const touchPoint = (x: number, y: number) => [
    { x: Math.round(x), y: Math.round(y) },
  ];

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: touchPoint(startX, startY),
  });

  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(16);
    const t = i / steps;
    const x = startX + (endX - startX) * t;
    const y = startY + (endY - startY) * t;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: touchPoint(x, y),
    });
  }

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });

  await page.waitForTimeout(500);
}

async function injectHorizontalOverflowStandIn(page: Page): Promise<void> {
  // Fixture bdboard.list.json now includes ~15 labels, but body { overflow-x: clip }
  // regressions are still tested with a deterministic 1312px stand-in (not layout-dependent).
  await page.evaluate(() => {
    const app = document.querySelector('.app');
    if (!app) throw new Error('.app not found');
    const standIn = document.createElement('div');
    standIn.setAttribute('data-testid', 'e2e-horizontal-overflow-standin');
    standIn.style.width = '1312px';
    standIn.style.height = '20px';
    standIn.style.flexShrink = '0';
    app.appendChild(standIn);
  });
}

async function ensurePageScrollable(page: Page) {
  let maxScrollY = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  );

  if (maxScrollY === 0) {
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.setAttribute('data-testid', 'e2e-scroll-spacer');
      spacer.style.height = '200vh';
      spacer.style.width = '100%';
      spacer.style.flexShrink = '0';
      document.querySelector('.app')?.appendChild(spacer);
    });
    maxScrollY = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    );
  }

  expect(maxScrollY, 'page must scroll vertically for sticky to be testable').toBeGreaterThan(
    0,
  );
  return maxScrollY;
}

async function expectHeaderSticksWhileScrolling(page: Page) {
  await page.goto('/');
  await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

  const maxScrollY = await ensurePageScrollable(page);
  const scrollY = Math.min(SCROLL_PROBE_Y, maxScrollY);
  expect(scrollY, 'probe scroll must be non-zero').toBeGreaterThan(0);

  await page.evaluate((y) => window.scrollTo(0, y), scrollY);

  const headerTop = await page.locator('.header').evaluate((element) => {
    return element.getBoundingClientRect().top;
  });

  expect(
    headerTop,
    `header should stick near top after scrollY=${scrollY} (maxScrollY=${maxScrollY})`,
  ).toBeLessThanOrEqual(HEADER_TOP_TOLERANCE_PX);
  expect(headerTop).toBeGreaterThanOrEqual(-HEADER_TOP_TOLERANCE_PX);
}

test.describe('header sticky', () => {
  test('375x812: header stays fixed while scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expectHeaderSticksWhileScrolling(page);
  });

  test('1280x800: header stays fixed while scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expectHeaderSticksWhileScrolling(page);
  });
});

test.describe('mobile horizontal pan', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: touch drag does not pan horizontally when body clips overflow', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    await injectHorizontalOverflowStandIn(page);

    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(
      innerWidth,
      `layout viewport must stay 375px after overflow injection (innerWidth=${innerWidth})`,
    ).toBe(375);

    // Vertical control first — proves CDP touch drag works. page.mouse.wheel does not
    // scroll under isMobile at all, which invalidates pan measurement. Run before horizontal
    // drag because horizontal pan shifts visualViewport and breaks a subsequent vertical check.
    await page.evaluate(() => window.scrollTo(0, 0));
    await dispatchTouchDrag(page, 187, 600, 187, 200);
    const scrollYAfterVertical = await page.evaluate(() => window.scrollY);
    expect(
      scrollYAfterVertical,
      `vertical touch drag should scroll the page (scrollY=${scrollYAfterVertical})`,
    ).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    await dispatchTouchDrag(page, 300, 400, 60, 400);
    const { offsetLeft, scrollX } = await page.evaluate(() => ({
      offsetLeft: window.visualViewport?.offsetLeft ?? 0,
      scrollX: window.scrollX,
    }));

    expect(
      Math.abs(offsetLeft),
      `horizontal touch drag must not shift visual viewport ` +
        `(visualViewport.offsetLeft=${offsetLeft}, scrollX=${scrollX})`,
    ).toBeLessThanOrEqual(VIEWPORT_OFFSET_TOLERANCE_PX);
  });
});

test.describe('scroll-padding-top', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: keyboard focus keeps cards below sticky header and lane strip', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });

    const stripProbe = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('.lane-indicator-strip');
      if (strip === null) {
        return { exists: false, display: null as string | null, height: 0 };
      }
      const style = window.getComputedStyle(strip);
      return {
        exists: true,
        display: style.display,
        height: strip.getBoundingClientRect().height,
      };
    });
    expect(
      stripProbe.exists,
      'mobile fixture must render .lane-indicator-strip for scroll-padding coverage',
    ).toBe(true);
    expect(
      stripProbe.display,
      `.lane-indicator-strip must be display:block on mobile (display=${stripProbe.display})`,
    ).toBe('block');
    expect(
      stripProbe.height,
      `.lane-indicator-strip must have non-zero height (height=${stripProbe.height})`,
    ).toBeGreaterThan(0);

    // Fixture lanes are height-capped on mobile; page scroll may never occur during j/k
    // navigation alone. Top spacer: board starts below the fold so j can reach scrollY > 0.
    // Bottom spacer: room to scroll past the board so we can push it above the viewport
    // before phase 2 — otherwise upward k may never scroll the document (depends on
    // --header-height vs focused card top; see file JSDoc).
    await page.evaluate(() => {
      const app = document.querySelector('.app');
      if (!app) throw new Error('.app not found');
      const topSpacer = document.createElement('div');
      topSpacer.setAttribute('data-testid', 'e2e-scroll-padding-spacer');
      topSpacer.style.height = '120vh';
      topSpacer.style.width = '100%';
      topSpacer.style.flexShrink = '0';
      app.insertBefore(topSpacer, app.firstChild);

      const bottomSpacer = document.createElement('div');
      bottomSpacer.setAttribute('data-testid', 'e2e-scroll-padding-bottom-spacer');
      bottomSpacer.style.height = '120vh';
      bottomSpacer.style.width = '100%';
      bottomSpacer.style.flexShrink = '0';
      app.appendChild(bottomSpacer);
    });

    const maxScrollY = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    );
    expect(maxScrollY, 'page must be vertically scrollable for this test').toBeGreaterThan(0);

    // Board keyboard nav listens on the board container (onKeyDown), not document — focus
    // must start inside the board. Use focus(), not click(): click opens the detail panel
    // and its focus trap, so j would not reach BoardKeyboardNavProvider.
    const entryCard = page.locator('.card[tabindex="0"]').first();
    await expect(entryCard).toBeVisible({ timeout: 15_000 });
    await entryCard.focus();
    await page.keyboard.press('j');

    const initialFocus = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.classList.contains('card');
    });
    expect(
      initialFocus,
      'first j press should focus a card when no card is selected and input is not focused',
    ).toBe(true);

    type FocusMetrics = {
      scrollY: number;
      headerBottom: number | null;
      stripTop: number | null;
      stripBottom: number | null;
      activeTop: number | null;
      isCard: boolean;
    };

    async function collectFocusMetrics(): Promise<FocusMetrics> {
      return page.evaluate(() => {
        const header = document.querySelector('.header');
        const strip = document.querySelector<HTMLElement>('.lane-indicator-strip');
        const active = document.activeElement;
        return {
          scrollY: window.scrollY,
          headerBottom: header ? header.getBoundingClientRect().bottom : null,
          stripTop: strip ? strip.getBoundingClientRect().top : null,
          stripBottom: strip ? strip.getBoundingClientRect().bottom : null,
          activeTop:
            active instanceof HTMLElement ? active.getBoundingClientRect().top : null,
          isCard: active instanceof HTMLElement && active.classList.contains('card'),
        };
      });
    }

    function stickyBottomFor(metrics: FocusMetrics): number {
      expect(metrics.headerBottom).not.toBeNull();
      let stickyBottom = metrics.headerBottom!;
      if (
        metrics.stripBottom !== null &&
        metrics.stripTop !== null &&
        metrics.stripTop <= metrics.headerBottom! + 1
      ) {
        stickyBottom = Math.max(stickyBottom, metrics.stripBottom);
      }
      return stickyBottom;
    }

    function assertCardBelowStickyChrome(
      metrics: FocusMetrics,
      direction: 'down' | 'up',
      move: number,
      key: 'j' | 'k',
    ) {
      expect(
        metrics.isCard,
        `activeElement should be a card after ${key} press #${move} (${direction})`,
      ).toBe(true);
      expect(
        metrics.activeTop,
        `focused card must exist after ${key} press #${move} (${direction}) ` +
          `(scrollY=${metrics.scrollY}, headerBottom=${metrics.headerBottom}, ` +
          `stripTop=${metrics.stripTop}, stripBottom=${metrics.stripBottom})`,
      ).not.toBeNull();
      expect(
        metrics.headerBottom,
        `header must exist after ${key} press #${move} (${direction}) ` +
          `(scrollY=${metrics.scrollY})`,
      ).not.toBeNull();
      const stickyBottom = stickyBottomFor(metrics);
      expect(
        metrics.activeTop!,
        `focused card top must be at or below sticky chrome bottom after ${key} press #${move} (${direction}) ` +
          `(scrollY=${metrics.scrollY}, activeTop=${metrics.activeTop}, ` +
          `headerBottom=${metrics.headerBottom}, stripTop=${metrics.stripTop}, ` +
          `stripBottom=${metrics.stripBottom}, stickyBottom=${stickyBottom})`,
      ).toBeGreaterThanOrEqual(stickyBottom - 1);
    }

    // Phase 1: move down until the page has scrolled (scrollY > 0).
    // Measured 375×812: j caps at scrollY≈1348; strip sticks at scrollY≥≈1362, so strip
    // sticky is never observed here — sawStripSticky is asserted after phase 2 only.
    let sawPageScroll = false;
    let sawStripSticky = false;
    const downMoveCount = 10;
    for (let move = 1; move <= downMoveCount; move += 1) {
      await page.keyboard.press('j');
      const metrics = await collectFocusMetrics();
      if (metrics.scrollY > 0) {
        sawPageScroll = true;
      }
      if (
        metrics.headerBottom !== null &&
        metrics.stripTop !== null &&
        metrics.stripTop <= metrics.headerBottom + 1
      ) {
        sawStripSticky = true;
      }
      assertCardBelowStickyChrome(metrics, 'down', move, 'j');
    }

    expect(
      sawPageScroll,
      'downward navigation must reach window.scrollY > 0 at least once ' +
        '(otherwise sticky-header overlap cannot be exercised)',
    ).toBe(true);

    // Phase 2: scroll to maxScrollY first so the board sits above the viewport; then k must
    // scroll the document up (scrollIntoView + scroll-padding-top), independent of header height.
    await page.evaluate((y) => window.scrollTo(0, y), maxScrollY);
    let upwardScrollCount = 0;
    let lastPhase2HeaderBottom: number | null = null;
    let lastPhase2StripTop: number | null = null;
    let previousScrollY = await page.evaluate(() => window.scrollY);
    const upMoveCount = 10;
    for (let move = 1; move <= upMoveCount; move += 1) {
      await page.keyboard.press('k');
      const metrics = await collectFocusMetrics();
      if (metrics.scrollY < previousScrollY) {
        upwardScrollCount += 1;
      }
      if (
        metrics.headerBottom !== null &&
        metrics.stripTop !== null &&
        metrics.stripTop <= metrics.headerBottom + 1
      ) {
        sawStripSticky = true;
      }
      lastPhase2HeaderBottom = metrics.headerBottom;
      lastPhase2StripTop = metrics.stripTop;
      previousScrollY = metrics.scrollY;
      assertCardBelowStickyChrome(metrics, 'up', move, 'k');
    }

    expect(
      upwardScrollCount,
      'upward navigation must scroll the document up at least once ' +
        `(upwardScrollCount=${upwardScrollCount}, finalScrollY=${previousScrollY}) ` +
        '— otherwise scroll-padding-top is not exercised',
    ).toBeGreaterThanOrEqual(1);

    expect(
      sawStripSticky,
      'upward navigation after scrollTo(maxScrollY) must observe lane strip stuck below header ' +
        '(otherwise strip scroll-padding coverage is vacuous — card overlap checks never ' +
        'include stripBottom). Measured phase 2: stripTop=193, headerBottom=193 at scrollY≈1402; ' +
        `last observed headerBottom=${lastPhase2HeaderBottom}, stripTop=${lastPhase2StripTop}`,
    ).toBe(true);
  });
});
