import { expect, test } from '@playwright/test';

/**
 * Mobile header compaction (bdboard-h4xs.5): grid-based GlobalBar, collapsed toolbar,
 * session count via status pill on narrow viewports.
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MAX_HEADER_HEIGHT_PX = 220;
// PC 幅の .global-bar は align-items:center で高さの違うコントロール (view-switcher 36px /
// btn-search 34px / status-pill 30px 等) を中央揃えするため、同じ1行でも rect.top は
// 実測 4.03px ばらつく (改修前後で一致)。20px はこのベースラインと、モバイル用 grid が
// PC 幅へ漏れたとき view-switcher が2行目に落ちて spread が 40px 以上になる故障モードを
// 明確に分離する。
const DESKTOP_GLOBAL_BAR_ROW_TOLERANCE_PX = 20;
const MIN_TAP_TARGET_PX = 44;
// カード可視判定: sticky ヘッダー下端〜折り返しの間に入っている高さが、カード自身の高さの
// この割合以上なら「可視」とみなす。絶対 px 閾値は環境差で落ちる向きなので使わない。
const MIN_VISIBLE_CARD_RATIO = 0.5;

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

    const metrics = await page.evaluate(({ minVisibleCardRatio }) => {
      const innerHeight = window.innerHeight;
      const cards = Array.from(document.querySelectorAll('.card'));
      const headerHeightVar = getComputedStyle(document.documentElement)
        .getPropertyValue('--header-height')
        .trim();
      const headerHeightPx = headerHeightVar.endsWith('px')
        ? Number.parseFloat(headerHeightVar)
        : Number.NaN;

      const header = document.querySelector('.header');
      const headerRect = header?.getBoundingClientRect();
      let headerBottom = headerRect?.bottom ?? 0;

      const laneStrip = document.querySelector('.lane-indicator-strip');
      if (laneStrip instanceof HTMLElement && headerRect) {
        const laneStyle = getComputedStyle(laneStrip);
        const laneVisible =
          laneStrip.offsetParent !== null &&
          laneStyle.display !== 'none' &&
          laneStyle.visibility !== 'hidden';
        if (laneVisible) {
          const stripRect = laneStrip.getBoundingClientRect();
          // スクロール0では通常フロー位置にいるだけ。ヘッダー直下に張り付いているときだけ
          // sticky が追加占有する領域として下端を勘定に入れる。
          if (stripRect.top <= headerRect.bottom + 1) {
            headerBottom = Math.max(headerBottom, stripRect.bottom);
          }
        }
      }

      let visibleCardCount = 0;
      const cardRects: Array<{ top: number; bottom: number; height: number }> = [];

      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        cardRects.push({ top: rect.top, bottom: rect.bottom, height: rect.height });
        const visible = Math.max(
          0,
          Math.min(rect.bottom, innerHeight) - Math.max(rect.top, headerBottom),
        );
        if (visible >= rect.height * minVisibleCardRatio) {
          visibleCardCount += 1;
        }
      }

      return {
        innerHeight,
        headerHeightPx,
        headerHeightVar,
        headerBottom,
        visibleCardCount,
        cardRects,
        cardsInspected: cards.length,
        minVisibleCardRatio,
      };
    }, { minVisibleCardRatio: MIN_VISIBLE_CARD_RATIO });

    // 100px 下限の可視高判定は「カードが小さく描画される環境で落ちる」向きで CI 踏み台と同型。
    // 「完全に折り返し内に収まる」判定 (rect.bottom <= innerHeight) は Tips バナーのローテーション
    // 文言の折り返し(20px)で 375x812 実測 5回中2回 fail する flaky だった (余裕 ~15px)。
    // 最悪 run でも visible/height ≈ 0.98 なので比率 0.5 閾値には約2倍の余裕がある。
    // モバイル圧縮無効(M1)では 1枚目が折り返しより下に落ち visible=0 となり確実に落ちる。
    // レーンストリップは張り付いているときだけ headerBottom に含める (スクロール0では通常フロー)。
    expect(
      metrics.visibleCardCount,
      `expected >=1 card with >=${metrics.minVisibleCardRatio * 100}% visible below sticky header ` +
        `(headerBottom=${metrics.headerBottom}, innerHeight=${metrics.innerHeight}, ` +
        `--header-height=${metrics.headerHeightVar}, ` +
        `cardRects=${JSON.stringify(metrics.cardRects.slice(0, 5))}, ` +
        `cardsInspected=${metrics.cardsInspected})`,
    ).toBeGreaterThanOrEqual(1);

    expect(
      metrics.headerHeightPx,
      `--header-height must be <= ${MAX_HEADER_HEIGHT_PX}px ` +
        `(actual=${metrics.headerHeightVar}, headerBottom=${metrics.headerBottom}, ` +
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

    const popoverBounds = await page.evaluate(() => {
      const popover = document.querySelector('.status-pill-popover');
      if (!popover) {
        return { found: false, left: 0, right: 0, innerWidth: window.innerWidth };
      }
      const rect = popover.getBoundingClientRect();
      return {
        found: true,
        left: rect.left,
        right: rect.right,
        innerWidth: window.innerWidth,
      };
    });

    expect(
      popoverBounds.found,
      'status pill popover must be present after opening',
    ).toBe(true);
    expect(
      popoverBounds.left >= 0 && popoverBounds.right <= popoverBounds.innerWidth,
      `status pill popover must fit within viewport ` +
        `(left=${popoverBounds.left}, right=${popoverBounds.right}, ` +
        `innerWidth=${popoverBounds.innerWidth})`,
    ).toBe(true);

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

  test('375x812: status pill, project picker, overflow menu and search meet 44px tap targets', async ({
    page,
  }) => {
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

  // 99px(CI Linux) vs 103px(macOS) の実測差。1280px では新規CSSが @media (max-width:700px) の
  // 内側にあるため適用されえず、ここでフォント由来の絶対ピクセル値を測る意味が無い。
  // 環境非依存な CSS 著者値で代替している。

  test('1280x800: header layout and first card position unchanged', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });

    const metrics = await page.evaluate(() => {
      const innerHeight = window.innerHeight;
      const header = document.querySelector('.header');
      const globalBar = document.querySelector('.global-bar');
      const toolbarLeft = document.querySelector('.view-toolbar-left');
      const metaBtn = document.querySelector('.view-toolbar .meta-text-btn');
      const firstCard = document.querySelector('.card');
      const projectPickerBtn = document.querySelector('.project-picker-button');
      const viewToolbar = document.querySelector('.view-toolbar');
      const overflowMenuBtn = document.querySelector('.overflow-menu-button');

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
        innerHeight,
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
        // 構造アサーション(display/topSpread)だけではモバイル用 min-height/width 漏れを検知できない。
        // 各モバイルルール群を CSS 著者値(minHeight/minWidth/columnGap)で1対1にカバーする。
        projectPickerMinHeight: projectPickerBtn
          ? getComputedStyle(projectPickerBtn).minHeight
          : null,
        globalBarColumnGap: globalBar
          ? getComputedStyle(globalBar).columnGap
          : null,
        viewToolbarColumnGap: viewToolbar
          ? getComputedStyle(viewToolbar).columnGap
          : null,
        overflowMenuMinWidth: overflowMenuBtn
          ? getComputedStyle(overflowMenuBtn).minWidth
          : null,
      };
    });

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
      metrics.projectPickerMinHeight,
      'mobile .project-picker-button min-height must not leak to desktop',
    ).toBe('30px');
    expect(
      metrics.globalBarColumnGap,
      'mobile .global-bar gap must not leak to desktop',
    ).toBe('16px');
    expect(
      metrics.viewToolbarColumnGap,
      'mobile .view-toolbar gap must not leak to desktop',
    ).toBe('16px');
    expect(
      metrics.overflowMenuMinWidth,
      'mobile .overflow-menu-button min-width must not leak to desktop',
    ).toBe('36px');

    expect(
      metrics.firstCardTop,
      `first card must be below header (firstCardTop=${metrics.firstCardTop}, headerHeight=${metrics.headerHeight})`,
    ).toBeGreaterThan(metrics.headerHeight);
    expect(
      metrics.firstCardTop,
      `first card must be above fold (firstCardTop=${metrics.firstCardTop}, innerHeight=${metrics.innerHeight})`,
    ).toBeLessThan(metrics.innerHeight);
  });
});
