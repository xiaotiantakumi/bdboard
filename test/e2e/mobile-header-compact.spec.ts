import { expect, test } from '@playwright/test';

/**
 * Mobile header compaction (bdboard-h4xs.5): grid-based GlobalBar, collapsed toolbar,
 * session count via status pill on narrow viewports.
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MIN_VISIBLE_CARD_HEIGHT_PX = 100;
const MAX_HEADER_HEIGHT_PX = 220;
const DESKTOP_HEADER_HEIGHT_PX = 103;
const DESKTOP_HEADER_HEIGHT_TOLERANCE_PX = 2;
// PC 幅の .global-bar は align-items:center で高さの違うコントロール (view-switcher 36px /
// btn-search 34px / status-pill 30px 等) を中央揃えするため、同じ1行でも rect.top は
// 実測 4.03px ばらつく (改修前後で一致)。8px はこのベースラインと、モバイル用 grid が
// PC 幅へ漏れたとき view-switcher が2行目に落ちて spread が 40px 以上になる故障モードを
// 明確に分離する。
const DESKTOP_GLOBAL_BAR_ROW_TOLERANCE_PX = 8;
const DESKTOP_FIRST_CARD_TOP_PX = 291.6;
const DESKTOP_FIRST_CARD_TOP_TOLERANCE_PX = 3;
const MIN_TAP_TARGET_PX = 44;

test.describe('mobile header compact — AC1 initial card visibility', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: at least one card is visible above the fold with compact header', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('.tips-banner')).toBeVisible();

    const cardCount = await page.locator('.card').count();
    expect(cardCount, 'fixture must expose at least one card').toBeGreaterThan(0);

    const metrics = await page.evaluate(
      ({ minVisible }) => {
        const innerHeight = window.innerHeight;
        const cards = Array.from(document.querySelectorAll('.card'));
        const headerHeightVar = getComputedStyle(document.documentElement)
          .getPropertyValue('--header-height')
          .trim();
        const headerHeightPx = headerHeightVar.endsWith('px')
          ? Number.parseFloat(headerHeightVar)
          : Number.NaN;

        let visibleCardCount = 0;
        let firstCardTop: number | null = null;
        let firstCardBottom: number | null = null;

        for (const card of cards) {
          const rect = card.getBoundingClientRect();
          if (firstCardTop === null) {
            firstCardTop = rect.top;
            firstCardBottom = rect.bottom;
          }
          const height =
            Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
          if (height >= minVisible) {
            visibleCardCount += 1;
          }
        }

        return {
          innerHeight,
          headerHeightPx,
          headerHeightVar,
          visibleCardCount,
          firstCardTop,
          firstCardBottom,
          cardsInspected: cards.length,
        };
      },
      {
        minVisible: MIN_VISIBLE_CARD_HEIGHT_PX,
      },
    );

    expect(
      metrics.visibleCardCount,
      `expected >=1 card with visibleHeight >= ${MIN_VISIBLE_CARD_HEIGHT_PX}px ` +
        `(firstCard top=${metrics.firstCardTop}, bottom=${metrics.firstCardBottom}, ` +
        `innerHeight=${metrics.innerHeight}, --header-height=${metrics.headerHeightVar}, ` +
        `cardsInspected=${metrics.cardsInspected})`,
    ).toBeGreaterThanOrEqual(1);

    expect(
      metrics.headerHeightPx,
      `--header-height must be <= ${MAX_HEADER_HEIGHT_PX}px ` +
        `(actual=${metrics.headerHeightVar}, firstCard top=${metrics.firstCardTop}, ` +
        `innerHeight=${metrics.innerHeight}, cardsInspected=${metrics.cardsInspected})`,
    ).toBeLessThanOrEqual(MAX_HEADER_HEIGHT_PX);
  });
});

test.describe('mobile header compact — AC2 session list via status pill', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: toolbar session button hidden; status pill opens session list', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    const toolbarSessionBtn = page.locator('.view-toolbar .meta-text-btn');
    await expect(toolbarSessionBtn).toHaveCount(1);
    await expect(toolbarSessionBtn).toBeHidden();

    await page.locator('.status-pill').click();
    const sessionBtn = page.locator('.status-pill-popover .status-pill-session-btn');
    await expect(sessionBtn).toBeVisible();
    await expect(sessionBtn).toBeEnabled();

    await sessionBtn.click();

    const sessionPanel = page.locator('#session-list-title');
    await expect(sessionPanel).toBeVisible({ timeout: 15_000 });
    await expect(sessionPanel).toContainText('セッション');
  });
});

test.describe('mobile header compact — AC3 tap targets', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: primary header controls meet 44px tap targets', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    const selectors = [
      '.btn-search',
      '.status-pill',
      '.project-picker-button',
      '.overflow-menu-button',
    ];

    const results = await page.evaluate(
      ({ selectors: sels }) => {
        return sels.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) {
            return { selector, found: false, width: 0, height: 0 };
          }
          const rect = element.getBoundingClientRect();
          return {
            selector,
            found: true,
            width: rect.width,
            height: rect.height,
          };
        });
      },
      { selectors },
    );

    expect(
      results.filter((r) => r.found).length,
      `expected ${selectors.length} tap targets, got ${results.filter((r) => r.found).length}`,
    ).toBe(selectors.length);

    for (const result of results) {
      expect(
        result.found,
        `missing tap target: ${result.selector}`,
      ).toBe(true);
      expect(
        result.height >= MIN_TAP_TARGET_PX && result.width >= MIN_TAP_TARGET_PX,
        `${result.selector} tap target too small (${result.width}x${result.height}, ` +
          `min=${MIN_TAP_TARGET_PX}x${MIN_TAP_TARGET_PX})`,
      ).toBe(true);
    }
  });
});

test.describe('mobile header compact — AC4 desktop unchanged', () => {
  test.use({
    viewport: DESKTOP_VIEWPORT,
  });

  test('1280x800: header layout and first card position unchanged', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });

    const metrics = await page.evaluate(
      ({
        desktopHeaderHeight,
        headerTolerance,
        rowTolerance,
        desktopFirstCardTop,
        cardTopTolerance,
      }) => {
        const header = document.querySelector('.header');
        const globalBar = document.querySelector('.global-bar');
        const toolbarLeft = document.querySelector('.view-toolbar-left');
        const metaBtn = document.querySelector('.view-toolbar .meta-text-btn');
        const firstCard = document.querySelector('.card');

        const globalBarChildSelectors = [
          '.header-title',
          '.view-switcher',
          '.btn-search',
          '.status-pill-widget',
          '.project-picker',
          '.overflow-menu',
        ];

        const childTops: number[] = [];
        for (const selector of globalBarChildSelectors) {
          const el = globalBar?.querySelector(`:scope > ${selector}`);
          if (el) {
            childTops.push(el.getBoundingClientRect().top);
          }
        }

        const topSpread =
          childTops.length > 0
            ? Math.max(...childTops) - Math.min(...childTops)
            : Number.NaN;

        return {
          headerHeight: header?.getBoundingClientRect().height ?? Number.NaN,
          globalBarDisplay: globalBar
            ? getComputedStyle(globalBar).display
            : null,
          toolbarLeftDisplay: toolbarLeft
            ? getComputedStyle(toolbarLeft).display
            : null,
          metaBtnVisible:
            metaBtn instanceof HTMLElement
              ? metaBtn.offsetParent !== null &&
                getComputedStyle(metaBtn).display !== 'none' &&
                getComputedStyle(metaBtn).visibility !== 'hidden'
              : false,
          firstCardTop: firstCard?.getBoundingClientRect().top ?? Number.NaN,
          globalBarChildCount: childTops.length,
          topSpread,
          desktopHeaderHeight,
          headerTolerance,
          rowTolerance,
          desktopFirstCardTop,
          cardTopTolerance,
        };
      },
      {
        desktopHeaderHeight: DESKTOP_HEADER_HEIGHT_PX,
        headerTolerance: DESKTOP_HEADER_HEIGHT_TOLERANCE_PX,
        rowTolerance: DESKTOP_GLOBAL_BAR_ROW_TOLERANCE_PX,
        desktopFirstCardTop: DESKTOP_FIRST_CARD_TOP_PX,
        cardTopTolerance: DESKTOP_FIRST_CARD_TOP_TOLERANCE_PX,
      },
    );

    expect(
      metrics.headerHeight,
      `desktop header height should be ${DESKTOP_HEADER_HEIGHT_PX}±${DESKTOP_HEADER_HEIGHT_TOLERANCE_PX}px`,
    ).toBeGreaterThanOrEqual(DESKTOP_HEADER_HEIGHT_PX - DESKTOP_HEADER_HEIGHT_TOLERANCE_PX);
    expect(metrics.headerHeight).toBeLessThanOrEqual(
      DESKTOP_HEADER_HEIGHT_PX + DESKTOP_HEADER_HEIGHT_TOLERANCE_PX,
    );

    expect(
      metrics.globalBarChildCount,
      'global-bar must have 6 direct layout children',
    ).toBe(6);
    expect(
      metrics.topSpread,
      `global-bar children should share one row (top spread=${metrics.topSpread}px)`,
    ).toBeLessThanOrEqual(DESKTOP_GLOBAL_BAR_ROW_TOLERANCE_PX);

    expect(
      metrics.globalBarDisplay,
      'mobile grid must not apply at desktop width',
    ).not.toBe('grid');
    expect(
      metrics.toolbarLeftDisplay,
      'mobile display:contents must not apply at desktop width',
    ).not.toBe('contents');

    expect(metrics.metaBtnVisible, 'toolbar session button must stay visible on desktop').toBe(
      true,
    );

    expect(
      metrics.firstCardTop,
      `first card top should be ${DESKTOP_FIRST_CARD_TOP_PX}±${DESKTOP_FIRST_CARD_TOP_TOLERANCE_PX}px`,
    ).toBeGreaterThanOrEqual(
      DESKTOP_FIRST_CARD_TOP_PX - DESKTOP_FIRST_CARD_TOP_TOLERANCE_PX,
    );
    expect(metrics.firstCardTop).toBeLessThanOrEqual(
      DESKTOP_FIRST_CARD_TOP_PX + DESKTOP_FIRST_CARD_TOP_TOLERANCE_PX,
    );
  });
});
