import { expect, test } from '@playwright/test';

import {
  assertAiQuotaBadgeVisible,
  assertBoardFilterBarCollapsed,
  findWorstCaseTipIndex,
  HELP_TIPS,
  installAiQuotaRoute,
  measureResidual,
  pinTipsBannerRandom,
  reportResidualMeasurement,
  TIP_COUNT,
  waitForHeaderHeightConvergence,
} from './fixtures/mobile-chrome-helpers.js';

const MOBILE_VIEWPORT = { width: 375, height: 812 };

/**
 * bdboard-qxt1: 375x812 で「先頭カードが少なくとも半分見える」ことを守る回帰ガード。
 *
 * 予算の決め方: ヘッダー下に積み上がるクローム (tips / 折りたたみ済みフィルタバー /
 * レーンインジケータ / レーンヘッダー) がどれだけ縦を食っても、先頭カードの上端が
 * ビューポート下端からカード高さの半分ぶん以上は上にいること。カード全高可視は直接
 * アサートし、さらに Linux CI のフォント差に対する下駄として fold 余裕
 * MIN_FOLD_MARGIN_PX 以上も確保する。
 *
 * worst-case 構成 (pin 済み tip + installAiQuotaRoute + header 収束待ち) で測る。
 * global-setup の BDBOARD_AI_QUOTA_DISABLED=1 だけでは header が実機より 42px 軽く、
 * Math.random 由来の tip 長さも毎回変わるため、実機より甘い方向に空振りする (bdboard-k21o
 * と同型の罠)。
 *
 * MIN_FOLD_MARGIN_PX=160 の根拠:
 * - 定義: foldMarginPx = innerHeight - firstCardTop。折り返しより上にカード用の縦スペースが
 *   何 px 残っているか。mobile-header-compact.spec.ts の [ac1] ログと同じ定義に揃えてある
 *   （同じ名前で違う量を指すと読み違えるため）。
 * - 実測（macOS Chromium 375x812、build:web 後、worst-case tip pin + ai-quota 枠あり、
 *   フィルタバー折りたたみ、2026-09-05）:
 *   firstCardTop=625.4375, innerHeight=812 → foldMarginPx=186.5625。閾値 160 に対し
 *   26.56px の余裕。
 * - 3 つの expect の関係: 「半分可視」は AC1 原文どおりの下限として残す。次の「全高可視」は
 *   firstCardTop + firstCardHeight <= viewportHeight を直接見る、実際に守りたい不変条件。
 *   最後の foldMargin >= 160 は Linux CI のフォント差に対する下駄であり、全高可視の代理ではない。
 *   後ろほど強い。現在のカード高さは 152.48px のため 160 が全高可視より強く実質 binding だが、
 *   カード高さが 160px を超えれば全高可視のほうが binding に入れ替わる。AC1 の元の要求
 *   （半分見える = firstCardTop <= 735.76）だけだと余裕が薄いときに「半分だけ見える」で緑になり、
 *   体験として「そこにカードがある」と分からない状態を通してしまう。
 * - 効果（bdboard-qxt1 の前後差）: 同じ worst-case 構成での firstCardTop は
 *   修正前 831.4375（macOS）/ 828.4375（Linux CI, run 33947408853）→ 修正後 625.4375（macOS）。
 *   約 206px の削減で、.board-filter-bar（展開時 約 256px）をモバイル幅で既定折りたたみに
 *   したぶんが主。bd の要求「必須 92.68px / 目標 160px 以上の削減」をどちらも満たす。
 * - プラットフォーム差について: bd の notes にある「macOS と Linux で約 96px ずれる」は、
 *   ai-quota 枠なしの暫定計測（macOS 732.11）と ai-quota 枠ありの Linux CI 計測（828.44）を
 *   突き合わせた値で、fixture が揃っていない。同一構成どうしの実測差は 3px
 *   （macOS 831.4375 / Linux 828.4375、しかも Linux のほうが小さい）。よって 26.56px の余裕は
 *   Linux CI のフォント差に対して十分で、同ファイル群が Linux フォント差用に使っている +16px の
 *   慣行よりも広い。
 */
const MIN_FOLD_MARGIN_PX = 160;

test.describe('mobile first card visibility (bdboard-qxt1)', () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test('375x812: at least half of the first card is inside the viewport', async ({ page }) => {
    test.setTimeout(60_000);

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
    const firstCard = page.locator('.card').first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.tips-banner')).toBeVisible();
    await assertAiQuotaBadgeVisible(page);
    const convergence = await waitForHeaderHeightConvergence(page);

    await expect(page.locator('.tips-banner-text strong')).toHaveText(selectedTip.title);
    await expect(page.locator('.tips-banner-text span')).toHaveText(selectedTip.description);
    await assertBoardFilterBarCollapsed(page);

    const m = await page.evaluate(() => {
      const px = (n: number) => Math.round(n * 100) / 100;
      const heightOf = (selector: string): number => {
        const el = document.querySelector(selector);
        return el ? px(el.getBoundingClientRect().height) : 0;
      };
      const card = document.querySelector('.card') as HTMLElement;
      const cardRect = card.getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        firstCardTop: px(cardRect.top),
        firstCardHeight: px(cardRect.height),
        maxScrollY: px(document.documentElement.scrollHeight - window.innerHeight),
        breakdown: {
          header: heightOf('.header'),
          tipsBanner: heightOf('.tips-banner'),
          boardFilterBar: heightOf('.board-filter-bar'),
          laneIndicatorStrip: heightOf('.lane-indicator-strip'),
          laneHeader: heightOf('.lane-header'),
        },
      };
    });

    // 成功時にも実測値を残す (bdboard-ij7g)。この spec は mobile-page-scroll-residual と
    // 同じ worst-case 構成で測っているので、同じプレフィクスで出しておくと
    // 「ヘッダーが最終形になる前の高さを読んでいた」問題の再発を CI ログだけで追える
    // (`.view-toolbar` が 2 行に折り返す前の header=203 をここだけ読んでいれば、
    // 実測が 42px 低いこととして即分かる)。
    const residual = await measureResidual(page);
    await reportResidualMeasurement('first-card-worst-case-tip', residual, {
      tipId: selectedTip.id,
      firstCardTop: m.firstCardTop,
      firstCardHeight: m.firstCardHeight,
      foldMarginPx: Math.round((m.viewportHeight - m.firstCardTop) * 100) / 100,
      minFoldMarginPx: MIN_FOLD_MARGIN_PX,
      laneHeader: m.breakdown.laneHeader,
      headerConvergedAfterMs: convergence.stableAfterMs,
      headerConvergenceQuietMs: convergence.quietMs,
      headerConvergenceSamples: convergence.samples,
      headerHeightVar: convergence.headerHeightVar,
      // `changes` は収束待ちを開始した後の変化履歴である。203 → 245 の折り返しは
      // `assertViewToolbarSettled` 完了時点で既に終わっているため、ここには現れない。
      // 初回サンプルと `--header-height` の 1 フレーム遅れにより、正常時も `245@0 245@16.7` の
      // ように同じ高さのエントリが 1〜2 個出る。異なる高さが並ぶときだけ待ち中に動いた証拠である。
      // ヘッダーを低く読んだ回 (203 のまま測った回) は、このフィールドではなくペイロードの
      // `header` フィールドで検知する (Linux CI ログで 203 と出れば一目で分かる)。
      headerHeightChanges: convergence.changes.join(' '),
    });

    // 「半分見える」= カード上端がビューポート下端よりカード高さの半分ぶん以上上にある。
    const budget = m.viewportHeight - m.firstCardHeight / 2;
    // 折り返し (= ビューポート下端) より上に、カード上端から何 px の縦スペースが残っているか。
    // mobile-header-compact.spec.ts の [ac1] ログの foldMarginPx と同じ定義。
    const foldMarginPx = m.viewportHeight - m.firstCardTop;

    expect(
      m.firstCardTop,
      `375x812: first card must be at least half visible — ` +
        `firstCardTop=${m.firstCardTop} must be <= ${budget} ` +
        `(viewportHeight=${m.viewportHeight}, firstCardHeight=${m.firstCardHeight}, ` +
        `over budget by ${(m.firstCardTop - budget).toFixed(2)}px, foldMargin=${foldMarginPx.toFixed(2)}px). ` +
        `Chrome breakdown: header=${m.breakdown.header}, tips=${m.breakdown.tipsBanner}, ` +
        `filterBar=${m.breakdown.boardFilterBar}, laneStrip=${m.breakdown.laneIndicatorStrip}, ` +
        `laneHeader=${m.breakdown.laneHeader}, maxScrollY=${m.maxScrollY}`,
    ).toBeLessThanOrEqual(budget);

    const firstCardBottom = m.firstCardTop + m.firstCardHeight;
    const fullVisibilityOverflowPx = firstCardBottom - m.viewportHeight;
    expect(
      firstCardBottom,
      `375x812: first card must be fully visible above the fold — ` +
        `firstCardTop=${m.firstCardTop}, firstCardHeight=${m.firstCardHeight}, ` +
        `viewportHeight=${m.viewportHeight}, over by ${fullVisibilityOverflowPx.toFixed(2)}px. ` +
        `Chrome breakdown: header=${m.breakdown.header}, tips=${m.breakdown.tipsBanner}, ` +
        `filterBar=${m.breakdown.boardFilterBar}, laneStrip=${m.breakdown.laneIndicatorStrip}, ` +
        `laneHeader=${m.breakdown.laneHeader}, maxScrollY=${m.maxScrollY}`,
    ).toBeLessThanOrEqual(m.viewportHeight);

    expect(
      foldMarginPx,
      `375x812: first card needs at least ${MIN_FOLD_MARGIN_PX}px fold margin ` +
        `(actual=${foldMarginPx.toFixed(2)}px, firstCardTop=${m.firstCardTop}, ` +
        `viewportHeight=${m.viewportHeight}, firstCardHeight=${m.firstCardHeight}, budget=${budget})`,
    ).toBeGreaterThanOrEqual(MIN_FOLD_MARGIN_PX);
  });
});
