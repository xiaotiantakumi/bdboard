import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function assertAiQuotaBadgeVisible(page: Page): Promise<void> {
  await expect(
    page.locator('.ai-quota-badge'),
    'AI クォータ枠が描画されていない。/api/ai-quota の route 差し替えが効いていないか、' +
      'AiQuotaWidget の描画条件が変わった。この枠が無い fixture の header は実機より 42px 軽く、' +
      '予算/可視性アサーションは空振りになる。',
  ).toBeVisible({ timeout: 15_000 });
}

/** --header-height が .header 実測に追いつくまで待つ (AiQuotaWidget 描画後 1 フレーム遅延)。 */
async function waitForHeaderHeightConvergence(page: Page): Promise<void> {
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
          '--header-height が .header の実測高に追いつかない。' +
          'レーンストリップ sticky top / scroll-padding-top のずれ原因。',
        timeout: 10_000,
      },
    )
    .toBeLessThanOrEqual(1);
}

/** Tips の原本。web/src/tipsContent.ts と同じ docs/help-content.json を直接読む。 */
interface HelpTipFixture {
  id: string;
  title: string;
  description: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP_TIPS: HelpTipFixture[] = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'docs/help-content.json'), 'utf8'),
) as HelpTipFixture[];
const TIP_COUNT = HELP_TIPS.length;

interface WorstCaseTipMeasurement {
  index: number;
  bannerHeight: number;
  heights: number[];
}

/** ブラウザ上で各 Tips 文言を差し替え、バナー高さが最大になる index を返す。 */
async function findWorstCaseTipIndex(page: Page): Promise<WorstCaseTipMeasurement> {
  return page.evaluate((tipsData) => {
    const banner = document.querySelector('.tips-banner');
    if (!banner) {
      throw new Error('.tips-banner not found');
    }

    const sourceRect = banner.getBoundingClientRect();
    const clone = banner.cloneNode(true) as HTMLElement;
    clone.style.position = 'absolute';
    clone.style.visibility = 'hidden';
    clone.style.left = '0';
    clone.style.top = '0';
    clone.style.width = `${sourceRect.width}px`;
    banner.parentElement?.insertBefore(clone, banner.nextSibling);

    const strong = clone.querySelector('.tips-banner-text strong');
    const span = clone.querySelector('.tips-banner-text span');
    if (!strong || !span) {
      clone.remove();
      throw new Error('.tips-banner-text strong/span not found');
    }

    const heights: number[] = [];
    let maxIndex = 0;
    let maxHeight = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < tipsData.length; i += 1) {
      strong.textContent = tipsData[i].title;
      span.textContent = tipsData[i].description;
      const height = clone.getBoundingClientRect().height;
      heights.push(height);
      if (height > maxHeight) {
        maxHeight = height;
        maxIndex = i;
      }
    }

    clone.remove();
    return { index: maxIndex, bannerHeight: maxHeight, heights };
  }, HELP_TIPS);
}

/**
 * TipsBanner の初期 index を決定論的に固定する。
 * Math.floor(Math.random() * tipCount) === index になるよう (index + 0.5) / tipCount を返す。
 *
 * この spec では preset 生成やパネル履歴トークン生成が走らないため、Math.random を定数化しても
 * 他機能への副作用はない (global-setup へ波及させないのは addInitScript をテスト内に閉じるため)。
 */
async function pinTipsBannerRandom(page: Page, index: number, tipCount: number): Promise<void> {
  await page.addInitScript(({ pinnedIndex, tipCount }) => {
    Math.random = () => (pinnedIndex + 0.5) / tipCount;
  }, { pinnedIndex: index, tipCount });
}

interface ContentStartMetrics {
  innerHeight: number;
  headerHeightVar: string;
  headerBottom: number;
  firstCardTop: number;
  tipsBannerHeight: number;
}

/** sticky ヘッダー下端と先頭カード上端。カード高さには依存しない。 */
async function collectContentStartMetrics(page: Page): Promise<ContentStartMetrics> {
  return page.evaluate(() => {
    const innerHeight = window.innerHeight;
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
        if (stripRect.top <= headerRect.bottom + 1) {
          headerBottom = Math.max(headerBottom, stripRect.bottom);
        }
      }
    }

    const firstCard = document.querySelector('.card');
    const firstCardTop = firstCard?.getBoundingClientRect().top ?? Number.NaN;

    const tipsBanner = document.querySelector('.tips-banner');
    const tipsBannerHeight = tipsBanner?.getBoundingClientRect().height ?? Number.NaN;

    return { innerHeight, headerHeightVar, headerBottom, firstCardTop, tipsBannerHeight };
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

// 先頭カード上端のラチェット (375x812, worst-case Tips + ai-quota 描画)。カード高さには依存しない。
//
// 旧 AC1 は「visible >= rect.height * 0.5 の .card が1枚以上」を見ていたが、2枚目以降は
// top > innerHeight で可視量 0 のため実質「先頭カード1枚の半分以上可視」しか判定できず、
// TipsBanner の Math.random 由来の1行/2行差 (~19px) とタイトル折り返し (~20px) の knife-edge
// (余裕 3.65px / 7.36px) で 12 回中 5 回 fail していた (2026-09-05 実測)。50% 可視カードは
// 実データでは 0 枚で不変条件は既に成立しており、product 側の問題は bdboard-qxt1。
//
// firstCardTop 一本のラチェットは Tips バナー (~199px) の折り返し行数が Linux CI フォント差で
// 1 行増えるだけ (≒ +19px) で閾値を越えて赤くなるため廃止。Tips 以外 (ヘッダー + ツールバー +
// ボード上部クローム) と Tips バナー高さを分離して ratchet する。
//
// worst-case Tips + 実機相当ヘッダーでは先頭カード上端が 831.44px で innerHeight=812 を超える
// (foldMargin=-19.44px)。カードが折り返し上に見えないのは product 側の問題で bdboard-qxt1 で
// 追跡。ここで緑にするために閾値を動かさない。
//
// MAX_CONTENT_START_EXCLUDING_TIPS_PX: contentStartExcludingTips = firstCardTop - tipsBannerHeight。
// Tips 折り返しに影響されない、ヘッダー + ツールバー + ボード上部クロームぶん (AC1 本体)。
// しきい値 = 実測最大の切り上げ + 16px (Linux CI フォント差。MAX_HEADER_HEIGHT_PX の +5px /
// AC4 の 99px vs 103px と同種。ここに含まれるのは単行要素ばかりなので 1 要素あたり数 px しか
// ぶれない)。
//
// 3 回実測 (pin 済み + installAiQuotaRoute, macOS Chromium 375x812, build:web 後, 2026-09-05):
//   run1/2/3: contentStartExcludingTips=632.625, tipsBannerHeight=198.8125
//   (firstCardTop=831.4375, headerBottom=245, tipId=next-up, 3/3 同値)
// → ceil(632.625)+16 = 649
const MAX_CONTENT_START_EXCLUDING_TIPS_PX = 649;
//
// MAX_TIPS_BANNER_HEIGHT_PX: .tips-banner の実測高さ。折り返し行数がフォント環境で動く唯一の
// 要素なので +24px (≒ 折り返し 1 行ぶん) の余裕。1 行増えても赤くならないが 2 行以上ぶん
// 肥大したら捕まえる。
//
// 上記 3 回実測 tipsBannerHeight=198.8125 (3/3 同値) → ceil(198.8125)+24 = 223
const MAX_TIPS_BANNER_HEIGHT_PX = 223;

// これを超える変更を入れるときは、数字を黙って上げるのではなく、なぜ予算を増やしてよいかを
// 根拠付きで書いてから上げること。前回より大きいから上げた、という形にすると次に本当の肥大が
// 来たとき誰も気付けない。

test.describe('mobile header compact — AC1 content start budget', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: content start stays within budget and first card is not hidden under the sticky header', async ({
    page,
  }) => {
    await installAiQuotaRoute(page);
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.tips-banner')).toBeVisible();
    await waitForHeaderHeightConvergence(page);

    const worstCase = await findWorstCaseTipIndex(page);
    const selectedTip = HELP_TIPS[worstCase.index];

    await pinTipsBannerRandom(page, worstCase.index, TIP_COUNT);
    await page.reload();
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.tips-banner')).toBeVisible();
    await assertAiQuotaBadgeVisible(page);
    await waitForHeaderHeightConvergence(page);

    // pin 前提条件: 選んだ Tips が実際に描画されていること (Math.random 固定の失効検知)。
    await expect(page.locator('.tips-banner-text strong')).toHaveText(selectedTip.title);
    await expect(page.locator('.tips-banner-text span')).toHaveText(selectedTip.description);

    const cardCount = await page.locator('.card').count();
    expect(cardCount, 'fixture must expose at least one card').toBeGreaterThan(0);

    const metrics = await collectContentStartMetrics(page);

    const contentStartExcludingTips = metrics.firstCardTop - metrics.tipsBannerHeight;
    const minHeight = Math.min(...worstCase.heights);
    const maxHeight = Math.max(...worstCase.heights);
    const foldMarginPx = metrics.innerHeight - metrics.firstCardTop;
    test.info().annotations.push({
      type: 'ac1-measurement',
      description:
        `worstTip index=${worstCase.index} id=${selectedTip.id} ` +
        `bannerHeight=${worstCase.bannerHeight}px (range ${minHeight}-${maxHeight}px), ` +
        `tipsBannerHeight=${metrics.tipsBannerHeight}, contentStartExcludingTips=${contentStartExcludingTips}, ` +
        `firstCardTop=${metrics.firstCardTop}, headerBottom=${metrics.headerBottom}, ` +
        `foldMarginPx=${foldMarginPx}`,
    });

    const debugInfo =
      `headerBottom=${metrics.headerBottom}, firstCardTop=${metrics.firstCardTop}, ` +
      `tipsBannerHeight=${metrics.tipsBannerHeight}, contentStartExcludingTips=${contentStartExcludingTips}, ` +
      `innerHeight=${metrics.innerHeight}, --header-height=${metrics.headerHeightVar}, ` +
      `tipId=${selectedTip.id}`;

    expect(
      contentStartExcludingTips,
      `content start excluding tips must stay within budget ` +
        `(max=${MAX_CONTENT_START_EXCLUDING_TIPS_PX}px, ${debugInfo})`,
    ).toBeLessThanOrEqual(MAX_CONTENT_START_EXCLUDING_TIPS_PX);

    expect(
      metrics.tipsBannerHeight,
      `tips banner height must stay within budget (max=${MAX_TIPS_BANNER_HEIGHT_PX}px, ${debugInfo})`,
    ).toBeLessThanOrEqual(MAX_TIPS_BANNER_HEIGHT_PX);

    expect(
      metrics.firstCardTop,
      `first card must not slide under sticky header (${debugInfo})`,
    ).toBeGreaterThanOrEqual(metrics.headerBottom);

    // header 高さ予算のアサーションは下の「header height budget」テストへ移した (bdboard-k21o)。
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
    await assertAiQuotaBadgeVisible(page);

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
