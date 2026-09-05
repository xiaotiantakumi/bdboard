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
 * MIN_FOLD_MARGIN_PX=170 の根拠 (bdboard-xn9p, 2026-09-06):
 * - 定義: foldMarginPx = innerHeight - firstCardTop。折り返しより上にカード用の縦スペースが
 *   何 px 残っているか。mobile-header-compact.spec.ts の [ac1] ログと同じ定義に揃えてある
 *   （同じ名前で違う量を指すと読み違えるため）。
 * - 実測（macOS Chromium 375x812、build:web 後、worst-case tip pin + ai-quota 枠あり、
 *   フィルタバー折りたたみ）: 本チケットで 2026-09-06 に再測定 (2 回連続実行で完全一致):
 *   firstCardTop=625.4375, innerHeight=812 → foldMarginPx=186.5625。
 * - Linux CI 実測 (ubuntu-latest。mobile-header-compact.spec.ts の MAX_CONTENT_START_PX
 *   コメントが引用する run 33952190457, 2026-09-05。同じ worst-case 構成で同じ firstCardTop
 *   を計測しているのでそのまま流用できる): firstCardTop=623.4375 →
 *   foldMarginPx=188.5625。macOS のほうが 2px 狭く、これは同ファイル群で繰り返し観測されている
 *   ヘッダー高のプラットフォーム差と同じ向き・同じ大きさ。よって両プラットフォームの
 *   実測最小値は macOS の 186.5625。
 * - 閾値の決め方 (独立な 2 通りの導出が一致する):
 *   1. 実測最小値からの単純な下駄: floor(186.5625) - 16 = 170。この -16px は
 *      mobile-header-compact.spec.ts の MAX_CONTENT_START_PX 等が使っている
 *      「Linux CI フォント差用の +16px」慣行と同じ値・同じ根拠。
 *   2. 兄弟予算との整合 (このチケットの主眼): このガードが縛る firstCardTop は
 *      mobile-header-compact.spec.ts の `MAX_CONTENT_START_PX = 642`
 *      (「first card top must stay within budget」) が**上限側からすでに**縛っている量と
 *      同一の値である。foldMarginPx = innerHeight - firstCardTop なので、
 *      MAX_CONTENT_START_PX を下回ってはならない閾値は
 *      innerHeight - MAX_CONTENT_START_PX = 812 - 642 = **170**。
 *      これを超えて (例えば 172 などへ) 締めると、firstCardTop が 640〜642px の範囲に
 *      育ったとき、名前の付いた MAX_CONTENT_START_PX のアサーションは緑のまま
 *      このガードだけが先に赤くなる窓ができる (bdboard-ij7g で
 *      MAX_NON_DISMISSIBLE_RESIDUAL_PX と MAX_HEADER_HEIGHT_PX/MAX_TIPS_BANNER_HEIGHT_PX の
 *      間に見つかったのと同型の問題)。170 ちょうどならこの窓は生じない —
 *      firstCardTop=642 ではどちらも境界で緑、642 を 1px でも超えればどちらも同時に赤くなる。
 *   両方の導出が同じ 170 に一致するのは偶然ではない。MAX_CONTENT_START_PX 自体が
 *   「macOS 実測 625.4375 の切り上げ (626) + 16px」で決められているため、①と②は同じ量を
 *   逆方向から見ているだけである。
 * - ヘッドルーム: macOS 186.5625 - 170 = 16.5625px、Linux 188.5625 - 170 = 18.5625px。
 *   MAX_CONTENT_START_PX 側のヘッドルーム (642 - firstCardTop、macOS 16.5625 /
 *   Linux 18.5625) と完全に一致する。定義上同じ量の裏表なので当然だが、方向の異なる
 *   2 本のアサーションが同じ余裕を報告していることは閾値の整合性の検算になる。
 * - 3 つの expect の関係: 「半分可視」は AC1 原文どおりの下限として残す。次の「全高可視」は
 *   firstCardTop + firstCardHeight <= viewportHeight を直接見る、実際に守りたい不変条件。
 *   最後の foldMargin >= 170 は Linux CI のフォント差に対する下駄であり、全高可視の代理ではない。
 *   後ろほど強い。現在のカード高さは 152.48px のため 170 が全高可視より強く実質 binding だが、
 *   カード高さが 170px を超えれば全高可視のほうが binding に入れ替わる。AC1 の元の要求
 *   （半分見える = firstCardTop <= 735.76）だけだと余裕が薄いときに「半分だけ見える」で緑になり、
 *   体験として「そこにカードがある」と分からない状態を通してしまう。
 * - 効果（bdboard-qxt1 の前後差、参考）: 同じ worst-case 構成での firstCardTop は
 *   修正前 831.4375（macOS）/ 828.4375（Linux CI, run 33947408853）→ 修正後 625.4375（macOS）。
 *   約 206px の削減で、.board-filter-bar（展開時 約 256px）をモバイル幅で既定折りたたみに
 *   したぶんが主。bd の要求「必須 92.68px / 目標 160px 以上の削減」をどちらも満たす。
 * - プラットフォーム差について: bd の notes にある「macOS と Linux で約 96px ずれる」は、
 *   ai-quota 枠なしの暫定計測（macOS 732.11）と ai-quota 枠ありの Linux CI 計測（828.44）を
 *   突き合わせた値で、fixture が揃っていない。同一構成どうしの実測差は一貫して 2〜3px
 *   （直近の firstCardTop では macOS 625.4375 / Linux 623.4375 で Linux のほうが 2px 小さい）。
 * - これ以上締めたい場合は、先に mobile-header-compact.spec.ts の MAX_CONTENT_START_PX を
 *   締めてから、同じ差分だけこちらも動かすこと。逆順にすると上記の窓が復活する。
 * - 「MAX_CONTENT_START_PX と等価なら、この 1 本は冗長では」への回答: 等価なのは
 *   **兄弟が 642 のときだけ**である。両者が同じ firstCardTop を縛っていても、片方は
 *   mobile-header-compact.spec.ts に、もう片方はこの「折り返しより上にカードが見えるか」の
 *   文脈にあり、緩められる理由が違う。兄弟が 642 から**緩められた**瞬間 (例: 700)、
 *   firstCardTop=660 は兄弟では緑になるがここでは foldMargin=152 < 170 で赤になり、
 *   このガードだけが独立に binding になる。つまりこれは兄弟の**緩和方向**に対する
 *   ラチェットとして働く — ヘッダーが太ったとき、予算を上げて追認する側の変更を
 *   別ファイルから 1 本止める。冗長に見える一致は現在値の偶然であって、統合してはいけない。
 */
const MIN_FOLD_MARGIN_PX = 170;

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
