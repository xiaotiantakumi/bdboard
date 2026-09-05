/**
 * bdboard-4ij6: モバイルの「ページスクロールとレーン内スクロールの二重構造」を、
 * ページ側の残差 maxScrollY として上限で縛る回帰ガード。
 *
 * ## このチケットの結論 (2026-09-05 実測にもとづく)
 *
 * bd の裁定どおり「二重構造そのものを潰す設計変更 (=.lane-indicator-strip の sticky を
 * ページスクロール非依存に作り替える)」は**やらない**。理由は下の分解が示すとおり、
 * 残差は「レイアウトの設計上そこにある」ものではなく **ユーザーが自分で消せるクローム
 * (Tips バナー / 絞り込みバー) が縦に積み上がったぶん**だからで、ページスクロールを
 * 無くすには同じ量だけ .lane の高さ上限 (100dvh - 260px) を削るしかなく、
 * カード表示面積が同量減って体験は悪くなる。
 *
 * 代わりに、bd が定義した客観量 (maxScrollY at 375x812) をそのまま実行可能な予算に落として
 * 二度と黙って膨らまないようにする。残差が 478px まで育ったのを誰も測っていなかったのが
 * このチケットの発生原因なので、守るべきはその「測り続ける」ほう。
 *
 * ## 実測 (macOS Chromium, 375x812, isMobile, build:web 後, 2026-09-05)
 *
 * worst-case 構成 (最長 tip を pin + AI クォータ枠あり + 絞り込みバーは既定の折りたたみ):
 *
 * | 構成                          | maxScrollY | tips   | filterBar |
 * |-------------------------------|-----------:|-------:|----------:|
 * | 最長 tip (index 3)            |        330 | 198.81 |        54 |
 * | 標準的な tip (21 件中 14 件)  |        272 | 141.48 |        54 |
 * | Tips を閉じた状態             |        131 |      0 |        54 |
 * | Tips 閉 + 絞り込みバー展開    |        389 |      0 |       308 |
 *
 * bd 記載の起点は 478px、bdboard-qxt1 着手時点の再計測は 436.48px。qxt1 (モバイル幅で
 * 絞り込みバーを既定折りたたみ) の副産物として 330px まで下がった。
 *
 * ## 分解
 *
 * どの構成でも maxScrollY - tips - filterBar は 77〜81px でほぼ一定になる。つまり残差は
 * 「Tips + 絞り込みバー + 一定の余白」でぴったり説明でき、それ以外の未知の縦積みは無い。
 * ヘッダー (245px) / レーンインジケータ (44px) / .lane (552px) は sticky と高さ上限で
 * ビューポートにほぼ収まるので、この一定項 (=どうやってもユーザーが消せない残差) にしか
 * 効いてこない。
 */

import { expect, test, type Page } from '@playwright/test';

import {
  assertAiQuotaBadgeVisible,
  findWorstCaseTipIndex,
  HELP_TIPS,
  installAiQuotaRoute,
  pinTipsBannerRandom,
  TIP_COUNT,
  waitForHeaderHeightConvergence,
} from './fixtures/mobile-chrome-helpers.js';

const MOBILE_VIEWPORT = { width: 375, height: 812 };

/**
 * ページスクロール残差の上限。
 *
 * 根拠: worst-case 実測 330px に対して 70px の余裕。tips バナーの 1 行は 19.11px
 * (21 件の実測が 141.48 / 160.59 / 179.70 / 198.81 と等間隔) なので、Linux CI の
 * フォント差で tip が 3 行増えても緑のまま。同時に bd 記載の起点 478px と
 * qxt1 着手時の 436.48px のどちらも下回るので、ラチェットとして本物。
 */
const MAX_PAGE_SCROLL_RESIDUAL_PX = 400;

/**
 * 「ユーザーが消せない」残差の上限 = maxScrollY から Tips と絞り込みバーの実測高を
 * 引いた残り。
 *
 * 上の予算 (400px) だけだと、ヘッダーや .lane 上限が 70px 育っても Tips が短い日は
 * 吸収されて気付けない。こちらは Tips/絞り込みバーの高さを両辺から落とすので
 * フォント差に鈍く、「Tips を閉じても付いて回る残差」だけを見る。
 *
 * 根拠: 実測 77.19px (worst-case) / 76.52 / 77.00 / 81.00 に対して 104px。
 * macOS と Linux CI のヘッダー実測差は同一構成で約 3px (bdboard-qxt1 の記録) なので
 * 23px の余裕は十分。
 */
const MAX_NON_DISMISSIBLE_RESIDUAL_PX = 104;

interface ResidualMetrics {
  maxScrollY: number;
  viewportHeight: number;
  header: number;
  tipsBanner: number;
  boardFilterBar: number;
  laneIndicatorStrip: number;
  lane: number;
}

async function measureResidual(page: Page): Promise<ResidualMetrics> {
  return page.evaluate(() => {
    const px = (n: number) => Math.round(n * 100) / 100;
    const heightOf = (selector: string): number => {
      const el = document.querySelector(selector);
      return el ? px(el.getBoundingClientRect().height) : 0;
    };
    return {
      maxScrollY: px(document.documentElement.scrollHeight - window.innerHeight),
      viewportHeight: window.innerHeight,
      header: heightOf('.header'),
      tipsBanner: heightOf('.tips-banner'),
      boardFilterBar: heightOf('.board-filter-bar'),
      laneIndicatorStrip: heightOf('.lane-indicator-strip'),
      lane: heightOf('.lanes-row .lane'),
    };
  });
}

function describeMetrics(m: ResidualMetrics): string {
  return (
    `maxScrollY=${m.maxScrollY}, viewportHeight=${m.viewportHeight}, ` +
    `header=${m.header}, tips=${m.tipsBanner}, filterBar=${m.boardFilterBar}, ` +
    `laneStrip=${m.laneIndicatorStrip}, lane=${m.lane}`
  );
}

test.describe('mobile page scroll residual (bdboard-4ij6)', () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test('375x812: page scroll residual stays within budget and is attributable to dismissible chrome', async ({
    page,
  }) => {
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
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.tips-banner')).toBeVisible();
    await assertAiQuotaBadgeVisible(page);
    await waitForHeaderHeightConvergence(page);
    await expect(page.locator('.tips-banner-text strong')).toHaveText(selectedTip.title);

    // 絞り込みバーの折りたたみは**あえて assert しない**。既定が展開へ戻ったら
    // (= bdboard-qxt1 の巻き戻し) それはヘルパーのエラーではなく残差の膨張として
    // 下の予算アサートに落としたい。
    const before = await measureResidual(page);

    expect(
      before.maxScrollY,
      `375x812: page scroll residual must stay within ${MAX_PAGE_SCROLL_RESIDUAL_PX}px — ` +
        `${describeMetrics(before)}. ` +
        `ページ側に残るスクロール量が増えるほど「指を置いた位置でページとレーンのどちらが動くか」が` +
        `変わる帯が広がる。増えたときはまず Tips / 絞り込みバー以外の縦積みが入っていないか疑う。`,
    ).toBeLessThanOrEqual(MAX_PAGE_SCROLL_RESIDUAL_PX);

    const nonDismissibleResidual =
      before.maxScrollY - before.tipsBanner - before.boardFilterBar;
    expect(
      nonDismissibleResidual,
      `375x812: residual that the user cannot dismiss must stay within ` +
        `${MAX_NON_DISMISSIBLE_RESIDUAL_PX}px — actual=${nonDismissibleResidual.toFixed(2)} ` +
        `(${describeMetrics(before)}). ` +
        `ヘッダー・レーンインジケータ・.lane の高さ上限のどれかが育つとここに出る。`,
    ).toBeLessThanOrEqual(MAX_NON_DISMISSIBLE_RESIDUAL_PX);

    // Tips を閉じると残差がその高さぶん実際に減ること = 残差が「消せるクローム」に
    // 帰属している証明。バナーが fixed 化したり跡地にプレースホルダが残ればここで落ちる。
    await page.getByRole('button', { name: 'Tipsを閉じる' }).click();
    await expect(page.locator('.tips-banner')).toHaveCount(0);
    await waitForHeaderHeightConvergence(page);
    const after = await measureResidual(page);

    const shrinkPx = before.maxScrollY - after.maxScrollY;
    expect(
      shrinkPx,
      `375x812: dismissing the tips banner must remove its full height from the page ` +
        `scroll residual — shrink=${shrinkPx.toFixed(2)} but tipsHeight=${before.tipsBanner}. ` +
        `before: ${describeMetrics(before)} / after: ${describeMetrics(after)}`,
    ).toBeGreaterThanOrEqual(before.tipsBanner - 4);
  });
});
