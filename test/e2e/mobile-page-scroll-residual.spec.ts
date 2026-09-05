/**
 * bdboard-4ij6: モバイルの「ページスクロールとレーン内スクロールの二重構造」を、
 * ページ側の残差 maxScrollY として上限で縛る回帰ガード。
 *
 * ## このチケットの結論 (2026-09-05)
 *
 * bd の裁定どおり「二重構造そのものを潰す設計変更 (= .lane-indicator-strip の sticky を
 * ページスクロール非依存に作り替える)」は**やらない**。ただし理由は「割に合わないから」では
 * なく **sticky が残差の原因ではないから**で、strip を作り替えても残差は 1px も減らない。
 *
 * 代わりに bd が定義した客観量 (maxScrollY at 375x812) をそのまま実行可能な予算に落として、
 * 二度と黙って膨らまないようにする。残差が 478px まで育ったのを誰も測っていなかったのが
 * このチケットの発生原因なので、守るべきはその「測り続ける」ほう。
 *
 * ## 残差のモデル (bdboard-knrx で更新。CSS から導出し、実測 4 点で検算した)
 *
 * bdboard-knrx が `.lane` / `.board-section .lane` の高さ上限を、リテラル
 * `calc(100dvh - 260px)` から「sticky クロームの下に残るビューポート帯」そのものへ
 * 置き換えた:
 *
 *     max-height: calc(100dvh - var(--header-height) - var(--lane-strip-height)
 *                      - var(--lanes-row-padding-bottom) - var(--main-padding)
 *                      - var(--bulk-bar-height, 0px))
 *
 * これでドキュメント高からヘッダー項が**打ち消し合って消える**:
 *
 *   docHeight = header + tips + filterBarBox
 *             + `.main` padding-top 12 + strip 44 + strip margin-bottom 10
 *             + lane (= 812 - header - 44 - 10 - 12)
 *             + `.lanes-row` padding-bottom 10 + `.main` padding-bottom 12
 *
 *   **maxScrollY = tips + filterBarBox + 22**   (22 = `.main` padding-top 12 + strip margin 10)
 *
 * つまり残差はもう**ヘッダー高に依存しない**。残る 22px は「sticky な strip が通常フローに
 * 残した 44px ぶんの席と、その上下の余白がヘッダーの裏へ流れ込む量」で、strip を sticky に
 * している限り構造的に消えない (sticky の作り替えは bdboard-4ij6 の裁定で対象外)。
 *
 * `filterBarBox` は `.board-filter-bar` の border-box 高 + margin-bottom (畳んで 4px /
 * 展開して 8px)。実測 (macOS Chromium, 375x812, isMobile, ai-quota 枠あり, 2026-09-05):
 *
 * | 構成                  | header | tips   | filterBar | lane | maxScrollY | モデル |
 * |-----------------------|-------:|-------:|----------:|-----:|-----------:|-------:|
 * | 最長 tip + バー畳     |    245 | 198.81 |   54 (+4) |  501 |        279 | 278.81 |
 * | 最長 tip + バー展開   |    245 | 198.81 |  308 (+8) |  501 |        537 | 536.81 |
 * | Tips 閉 + バー畳      |    245 |      0 |   54 (+4) |  501 |         80 |  80.00 |
 * | Tips 閉 + バー展開    |    245 |      0 |  308 (+8) |  501 |        338 | 338.00 |
 *
 * ズレは `documentElement.scrollHeight` が整数へ丸まるぶんだけ。修正前の同じ 4 点は
 * 330 / 588 / 131 / 389 で、全構成が**ちょうど 51px** 下がった (= lane 552 → 501)。
 *
 * ## 51px はカード表示面積から出ている (ここがこの変更の代償)
 *
 * 旧 260 の内訳は strip 44 + 固定 padding 44 + **ヘッダー 245 のうち 172 だけ**で、
 * 賄えていない 73px が「最大スクロール時にレーン上端 51.19px が sticky strip の下へ潜り、
 * レーン下端の下に 22.19px 余る」形で出ていた (bdboard-knrx)。潜り込みを 0 にするには
 * レーン上限を 552 → 501 に下げるしかなく、`.lane-cards` の窓は 503.38 → 452.38 に縮む。
 * 引き換えに、それまで一度も見えなかった `.lane-header` (46.63px) が見えるようになる。
 *
 * 式が変数化されたので、ヘッダーを縮める作業 (bdboard-qxt1) はそのぶん**カード面積として
 * 自動的に返ってくる**。残差 (= tips + filterBarBox + 22) のほうはもう動かない。
 *
 * ## このガードが構造的に見ていないもの
 *
 * `body` / `#root` / `.app` の `min-height: 100vh` (index.css 149 / 162 / 166)。`vh` は
 * large viewport にマップされるので、実機のモバイルブラウザではアドレスバーが出ている間
 * `lvh - dvh` ぶんの残差の床が常に乗る。Playwright の固定 viewport では
 * `lvh === dvh` で常に 0 になるため、この予算には一度も現れない。カード面積ゼロコストで
 * 消せる話なので bdboard-rhv0 に切り出した。
 */

import { expect, test } from '@playwright/test';

import {
  assertAiQuotaBadgeVisible,
  describeResidualMetrics,
  findWorstCaseTipIndex,
  HELP_TIPS,
  installAiQuotaRoute,
  measureResidual,
  pinTipsBannerRandom,
  TIP_COUNT,
  waitForHeaderHeightConvergence,
} from './fixtures/mobile-chrome-helpers.js';

const MOBILE_VIEWPORT = { width: 375, height: 812 };

/**
 * ページスクロール残差の上限。
 *
 * 根拠: worst-case 実測 279px (macOS Chromium, bdboard-knrx 後) に対して 30px の余裕。
 * 新しいモデル (maxScrollY = tips + filterBarBox + 22) はヘッダー高を含まないので、
 * Linux CI との差は tipsBanner の折り返しだけに縮んだ。その tipsBannerHeight は
 * `mobile-header-compact.spec.ts` の 2026-09-05 ubuntu-latest 実測で 198.8125 と
 * macOS に 1px の差もなく一致している (headerBottom のほうは Linux 243 / macOS 245 だが、
 * それはもうこの式に入らない)。リポジトリの慣行 (+16px) の 2 倍近くを取ってある。
 *
 * 360 は bdboard-knrx の修正後には緩すぎる: レーン上限をリテラル `100dvh - 260px` へ
 * 戻すミューテーション (maxScrollY=330) が素通りしてしまう。309 なら捕まる。
 * 起点 478px、bdboard-4ij6 時点の 360px のいずれも下回るので、ラチェットとして本物。
 */
const MAX_PAGE_SCROLL_RESIDUAL_PX = 309;

/**
 * 「ユーザーが消せない」残差の上限 = maxScrollY から Tips と絞り込みバーの実測高を
 * 引いた残り。bdboard-knrx 後のモデルではこれは
 * `filterBarMarginBottom + .main padding-top + strip margin-bottom` = 4 + 12 + 10 = 26
 * (バー展開時は 8 + 12 + 10 = 30) で、**フォントにもヘッダー高にも依存しない純粋な px 定数**。
 *
 * 上の予算だけだと、`.lane` 上限が育っても Tips が短い日は吸収されて気付けない。
 * こちらは Tips/絞り込みバーの高さを両辺から落とすので、Tips の折り返し行数に鈍い。
 *
 * 根拠: 実測 26.19px (worst-case, バー畳) / 30.19 (バー展開) / 26.00 / 30.00 に対して 40px。
 * 定数項しか含まないため CI とのブレは丸めの 0.2px 程度で、13.8px の余裕は十分。
 * 逆に、レーン上限から `--lane-strip-height` の項を落とすミューテーション (+44px →
 * 70.19px) も、リテラル `100dvh - 260px` への差し戻し (77.19px) も、ここで捕まる。
 * 旧値 104 はヘッダー高を縛る意図だったが、新モデルではヘッダーはこの式に入らないので
 * 意味を失っている (ヘッダーのラチェットは mobile-header-compact.spec.ts の
 * MAX_HEADER_HEIGHT_PX = 250 が単独で担う)。
 */
const MAX_NON_DISMISSIBLE_RESIDUAL_PX = 40;

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
    // 本文 (span) まで一致を見る。タイトルだけだと、pin が効いていても description が
    // 別の tip のままという壊れ方 (= バナー高さが worst-case にならない) を見逃す。
    await expect(page.locator('.tips-banner-text strong')).toHaveText(selectedTip.title);
    await expect(page.locator('.tips-banner-text span')).toHaveText(selectedTip.description);

    // 絞り込みバーの折りたたみは**あえて assert しない**。既定が展開へ戻ったら
    // (= bdboard-qxt1 の巻き戻し) それはヘルパーのエラーではなく残差の膨張として
    // 下の予算アサートに落としたい。
    const before = await measureResidual(page);

    expect(
      before.maxScrollY,
      `375x812: page scroll residual must stay within ${MAX_PAGE_SCROLL_RESIDUAL_PX}px — ` +
        `${describeResidualMetrics(before)}. ` +
        `ページ側に残るスクロール量が増えるほど「指を置いた位置でページとレーンのどちらが動くか」が` +
        `変わる帯が広がる。モデルは maxScrollY = tips + filterBarBox + 22 なので、` +
        `増えたときはまず .lane の max-height 式 (--header-height / --lane-strip-height を` +
        `引いているか) と Tips/絞り込みバーの高さを疑う。`,
    ).toBeLessThanOrEqual(MAX_PAGE_SCROLL_RESIDUAL_PX);

    const nonDismissibleResidual =
      before.maxScrollY - before.tipsBanner - before.boardFilterBar;
    expect(
      nonDismissibleResidual,
      `375x812: residual that the user cannot dismiss must stay within ` +
        `${MAX_NON_DISMISSIBLE_RESIDUAL_PX}px — actual=${nonDismissibleResidual.toFixed(2)} ` +
        `(${describeResidualMetrics(before)}). ` +
        `モデル上これは filterBar margin + .main padding-top + strip margin-bottom の ` +
        `純粋な定数なので、.lane の max-height 式が減算項を落としたときにここへ出る。`,
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
        `before: ${describeResidualMetrics(before)} / after: ${describeResidualMetrics(after)}`,
    ).toBeGreaterThanOrEqual(before.tipsBanner - 4);
  });
});
