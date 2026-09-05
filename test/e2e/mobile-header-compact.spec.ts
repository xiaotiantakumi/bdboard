import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile header compaction (bdboard-h4xs.5): grid-based GlobalBar, collapsed toolbar,
 * session count via status pill on narrow viewports.
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

/**
 * `/api/ai-quota` のレスポンス形。正本は web/src/api.ts の AiQuotaDto 系で、ここはその
 * wire 形だけを写したローカル定義 (e2e は独立 tsc プロジェクトなので web/src から import しない)。
 * ai-quota-popover-clamp.spec.ts と同じ写し方。
 */
interface AiQuotaFixtureMetric {
  label: string;
  percentRemaining?: number;
  resetAt?: string;
  status?: 'available' | 'exhausted';
}
interface AiQuotaFixtureProvider {
  id: string;
  label: string;
  availability: 'live' | 'manual' | 'unavailable';
  metrics: AiQuotaFixtureMetric[];
}
interface AiQuotaFixture {
  state: 'ok';
  fetchedAt: string;
  providers: AiQuotaFixtureProvider[];
}

// live プロバイダーが 1 つでもあれば .ai-quota-badge は描画される (AiQuotaWidget.tsx)。
// バッジのラベルは `AIクォータ NN%使用` 固定長なので、プロバイダー数を増やしても
// ヘッダー高さは変わらない (増えるのはポップオーバー内だけ)。
const AI_QUOTA_FIXTURE: AiQuotaFixture = {
  state: 'ok',
  fetchedAt: '2026-09-11T00:00:00.000Z',
  providers: [
    {
      id: 'cursor',
      label: 'Cursor',
      availability: 'live',
      metrics: [
        {
          label: 'CURSOR Weekly Limit Remaining',
          percentRemaining: 99,
          resetAt: '2026-09-11T06:10:00.000Z',
        },
        { label: 'CURSOR Five Hour Limit Remaining', status: 'available' },
      ],
    },
  ],
};

async function installAiQuotaRoute(page: Page): Promise<void> {
  await page.route('**/api/ai-quota', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(AI_QUOTA_FIXTURE),
    });
  });
}

// 実機相当の header 高さラチェット。設計上の予算ではなく「現状より増やさない」ための固定値。
//
// 旧値 220 は fixture のヘッダーが実機より 42px 軽かったせいで通っていただけだった
// (bdboard-k21o)。global-setup.ts が BDBOARD_AI_QUOTA_DISABLED=1 を渡すので fixture には
// AiQuotaWidget (.ai-quota-badge, .view-toolbar 内) が描画されず、375x812 実測で
// header=203px にしかならない。同じ幅の実ボードは 245px なので、旧閾値は実機の状態を
// 一度も見ないまま緑を出し続けていた。
//
// 下の budget テストは page.route で /api/ai-quota を live 応答に差し替えて枠を描画させる。
// その状態の実測は 245px (macOS Chromium, 2026-09-05, 3回とも同値) で、同日に実ボード
// (localhost:8787, main) を同じ 375x812 で測った 245px と 0px 差で一致する。バッジ有無の
// 差 42px がそのまま埋まった形。250 はそこへ約 5px だけ足した値 (Linux CI とのフォント差ぶん。
// 同ファイル AC4 の 99px(CI Linux) vs 103px(macOS) が前例)。
//
// 235px → 245px の +10px は、PR #346 (bdboard-h4xs.9) が .view-switcher を WCAG 2.5.8 の
// 最小タップ領域 44px に合わせて底上げした結果であって、レイアウトの劣化やヘッダーの肥大では
// ない。アクセシビリティ上必要な product 変更を1回だけ閾値に通した、という意味の +10px。
// (ヘッダーが 812px ビューポートの約 30% を占めていること自体は別問題として bdboard-qxt1。
// このラチェットはヘッダーを縮める役ではなく、これ以上太らせない役。)
//
// これを超える変更を入れるときは、数字を黙って上げるのではなく、上の +10px と同じように
// 「なぜヘッダー予算を増やしてよいか」を根拠付きで書いてから上げること。前回より大きいから
// 上げた、という形にすると次に本当の肥大が来たとき誰も気付けない。
const MAX_HEADER_HEIGHT_PX = 250;
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

    // header 高さ予算のアサーションは下の「header height budget」テストへ移した (bdboard-k21o)。
    // ここに残すと 193px の軽い fixture に対する空振りアサーションになり、このチケットが
    // 直そうとしている失敗形そのものを再生産する。AC1 はカード可視性だけを見る。
  });
});

test.describe('mobile header compact — header height budget (bdboard-k21o)', () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test('375x812: header stays within budget with the real board control set', async ({ page }) => {
    await installAiQuotaRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    // fixture 前提条件のアサーション: このバッジが出ていないと header は実機より 42px 軽くなり、
    // 予算アサーションは何も見ていないのと同じになる (bdboard-k21o の元の不具合)。
    // board-filter-mobile-reach.spec.ts の `labelCount >= 10`、
    // hygiene-reclaim-status-overflow.spec.ts の staleLeases 前提と同じ役割。
    await expect(
      page.locator('.ai-quota-badge'),
      'AI クォータ枠が描画されていない。/api/ai-quota の route 差し替えが効いていないか、' +
        'AiQuotaWidget の描画条件が変わった。この枠が無い fixture の header は実機より 42px 軽く、' +
        '下の予算アサーションは空振りになる。',
    ).toBeVisible({ timeout: 15_000 });

    // --header-height は useHeaderHeightVar の ResizeObserver 経由で 1 フレーム遅れて追いつく
    // (実測: バッジ描画直後は 203px のまま → 収束後 245px)。収束を待ってから比較する。
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const header = document.querySelector('.header');
            if (!header) {
              return Number.POSITIVE_INFINITY;
            }
            const headerHeight = header.getBoundingClientRect().height;
            const headerHeightVarStr = getComputedStyle(document.documentElement)
              .getPropertyValue('--header-height')
              .trim();
            const headerHeightVar = headerHeightVarStr.endsWith('px')
              ? Number.parseFloat(headerHeightVarStr)
              : Number.NaN;
            if (!Number.isFinite(headerHeightVar)) {
              return Number.POSITIVE_INFINITY;
            }
            return Math.abs(headerHeightVar - Math.ceil(headerHeight));
          }),
        {
          message:
            '--header-height が .header の実測高に追いつかない。この変数は ' +
            '.lane-indicator-strip の sticky top と html の scroll-padding-top を駆動するので、' +
            'ずれるとレーンストリップがヘッダーの下に潜る。' +
            '(#346 マージ後の 2026-09-05 に実ボードを測り直した時点では var=245px / 実測 245px で ' +
            '一致しており、以前記録された 37.5px のずれは再現しなかった。追跡は bdboard-s61q)',
          timeout: 10_000,
        },
      )
      .toBeLessThanOrEqual(1);

    const metrics = await page.evaluate(() => {
      const innerHeight = window.innerHeight;
      const header = document.querySelector('.header');
      const headerRect = header?.getBoundingClientRect();
      const headerHeight = headerRect?.height ?? Number.NaN;
      const headerHeightVarStr = getComputedStyle(document.documentElement)
        .getPropertyValue('--header-height')
        .trim();
      const headerHeightVar = headerHeightVarStr.endsWith('px')
        ? Number.parseFloat(headerHeightVarStr)
        : Number.NaN;
      const globalBar = document.querySelector('.global-bar');
      const viewToolbar = document.querySelector('.view-toolbar');
      const aiQuotaBadge = document.querySelector('.ai-quota-badge');

      return {
        innerHeight,
        headerHeight,
        headerHeightVar,
        globalBarHeight: globalBar?.getBoundingClientRect().height ?? Number.NaN,
        viewToolbarHeight: viewToolbar?.getBoundingClientRect().height ?? Number.NaN,
        aiQuotaBadgeHeight: aiQuotaBadge?.getBoundingClientRect().height ?? Number.NaN,
        aiQuotaBadgeWidth: aiQuotaBadge?.getBoundingClientRect().width ?? Number.NaN,
      };
    });

    expect(
      metrics.headerHeight,
      `header must stay within ${MAX_HEADER_HEIGHT_PX}px budget ` +
        `(actual=${metrics.headerHeight}, --header-height=${metrics.headerHeightVar}, ` +
        `global-bar=${metrics.globalBarHeight}, view-toolbar=${metrics.viewToolbarHeight}, ` +
        `ai-quota-badge=${metrics.aiQuotaBadgeWidth}x${metrics.aiQuotaBadgeHeight}, ` +
        `innerHeight=${metrics.innerHeight})`,
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

const BOUNDS_EPSILON_PX = 0.5;

test.describe('mobile header compact — status pill popover fits 320px (bdboard-h4xs.13)', () => {
  test.use({
    viewport: { width: 320, height: 568 },
    isMobile: true,
    hasTouch: true,
  });

  test('320x568: status pill popover stays within viewport', async ({ page }) => {
    // 修正前の実測: left=149.84, right=369.84, innerWidth=320 → 右へ 49.84px はみ出し。
    // body { overflow-x: clip } のためスクロールバーは出ず無言で切り落とされる。
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    await page.locator('.status-pill').click();
    await expect(page.locator('.status-pill-popover')).toBeVisible();

    const sessionBtn = page.locator('.status-pill-popover .status-pill-session-btn');
    await expect(sessionBtn).toBeVisible();

    const metrics = await page.evaluate((epsilon) => {
      const popover = document.querySelector('.status-pill-popover');
      if (!popover) {
        return { found: false, left: 0, right: 0, width: 0, innerWidth: window.innerWidth, epsilon };
      }
      const rect = popover.getBoundingClientRect();
      return {
        found: true,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        innerWidth: window.innerWidth,
        epsilon,
      };
    }, BOUNDS_EPSILON_PX);

    expect(metrics.found, 'status pill popover must be present after opening').toBe(true);
    expect(
      metrics.left >= -metrics.epsilon && metrics.right <= metrics.innerWidth + metrics.epsilon,
      `status pill popover must fit within viewport ` +
        `(left=${metrics.left}, right=${metrics.right}, width=${metrics.width}, ` +
        `innerWidth=${metrics.innerWidth})`,
    ).toBe(true);
  });
});
