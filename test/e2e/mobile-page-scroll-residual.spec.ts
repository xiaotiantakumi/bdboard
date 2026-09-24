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
 * ## 残差のモデル (CSS から導出し、実測 5 点で検算した)
 *
 * モバイル (`max-width: 700px`) の `web/src/index.css` で効いているのは 2 か所:
 *
 *   `@media (max-width: 700px)` 内の `.lane` / `.board-section .lane`
 *       max-height: calc(100dvh - 260px - var(--bulk-bar-height, 0px))
 *   ベースの `.header` ルール
 *       position: sticky
 *
 * `.lane` の **260 は `--header-height` を参照しないリテラル**で、`.header` は sticky =
 * 通常フローに残るため高さがそのまま document 高に加算される。ドキュメント高は
 *
 *   header + tips + filterBarBox
 *     + `.main` padding 12+12 + strip 44 + strip margin-bottom 10
 *     + `.lanes-row` padding-bottom 10 + lane (= 100dvh - 260 = 552)
 *
 * なので viewport 812 を引くと、可変項がきれいに残って
 *
 *   **maxScrollY = header + tips + filterBarBox - 172**   (172 = 260 - 44 - (12 + 12 + 10 + 10))
 *
 * `filterBarBox` は `.board-filter-bar` の border-box 高 + margin-bottom (畳んで 4px /
 * 展開して 8px)。実測 (macOS Chromium, 375x812, isMobile, ai-quota 枠あり, 2026-09-05):
 *
 * | 構成                  | header | tips   | filterBar | maxScrollY | モデル |
 * |-----------------------|-------:|-------:|----------:|-----------:|-------:|
 * | 最長 tip + バー畳     |    245 | 198.81 |   54 (+4) |        330 | 329.81 |
 * | 最長 tip + バー展開   |    245 | 198.81 |  308 (+8) |        588 | 587.81 |
 * | Tips 閉 + バー畳      |    245 |      0 |   54 (+4) |        131 | 131.00 |
 * | Tips 閉 + バー展開    |    245 |      0 |  308 (+8) |        389 | 389.00 |
 *
 * ズレは `documentElement.scrollHeight` が整数へ丸まるぶんだけ。5 点目は「再現しない
 * 異常値」として bdboard-ij7g に投げられた header=203 / maxScrollY=288 の初回プローブで、
 * モデルは 203 + 198.81 + 58 - 172 = 287.81 → 288。**異常値ではなく、`.view-toolbar` が
 * まだ 2 行に折り返していない状態 (ヘッダー 203) の同じレイアウト**にすぎない。
 * bdboard-ij7g で決着済み: 折り返しの引き金は ai-quota 枠ではなく、そのとき最後に届いた
 * 非同期コントロール (実測ではチャットボタン)。フレーム単位のトレースと、旧待ちで 203 を
 * 決定論的に再現させるミューテーション手順は
 * `fixtures/mobile-chrome-helpers.ts` の `waitForHeaderHeightConvergence` に書いてある。
 *
 * したがって **Tips も絞り込みバーも畳んだあとに残る残差 = header - 168** (= header + 4 - 172、
 * bdboard-mkm1.1 以降はこれに下の PROJECT_SECTION_OVERHEAD_PX が加わる)。
 * 正体は固定パディングではなく**ヘッダーそのもの**で、`kanban-mobile-lanes.spec.ts:69-70`
 * の「maxScrollY はヘッダー高 H に比例する」と一致する。
 *
 * ## 「残差を消すとカード面積が減る」というトレードオフは無い
 *
 * 260 のリテラルは strip 44 + 固定パディング 44 + **ヘッダー 245 のうち 172 だけ**を賄って
 * いる。足りない 73 と、畳んだ絞り込みバーの箱 58 の合計 131 が「Tips 閉 + バー畳」の残差
 * そのもの (73 + 58 = 131、上表 3 行目に一致)。よって残差はヘッダー由来であり、
 * **ヘッダーを縮めればカード面積 (= 100dvh - 260) を 1px も削らずに残差が減る**。
 * 実際、ツールバーが 1 行に収まってヘッダーが 42px 低い上記 5 点目では lane は 552 のまま
 * maxScrollY だけが 330 → 288 に落ちている。ヘッダーは 812 の 30% を占めており、
 * その圧縮は bdboard-qxt1 / bdboard-knrx の担当。260 を実チェーン (~337) に合わせる
 * 選択肢も bdboard-knrx が引き取っている。
 *
 * ## 測定値は成功時にも CI ログに残る (bdboard-ij7g)
 *
 * 予算アサーションのメッセージは失敗時にしか出ないので、Linux CI の実測が一度も記録されない
 * まま余裕を厚めに取るしかなかった。`reportResidualMeasurement` が成功時にも 1 行 JSON を
 * `MOBILE_SCROLL_RESIDUAL_MEASUREMENT=` 付きで出すので、CI ログを
 * `grep -o 'MOBILE_SCROLL_RESIDUAL_MEASUREMENT=.*'` で拾って macOS 実測と突き合わせられる。
 * bdboard-ij7g のラウンド 2 で、Linux/macOS の直接実測を得た。実測で締めたのは下の 2 つ目
 * (Tips に鈍い残差) で、1 つ目のページ予算は実測ではなく兄弟予算の合計から決めている
 * — 理由はその JSDoc に書いた。bdboard-m070 (2026-09-24) も同じ「成功時ログ→次ラウンドで
 * 締め直す」手順で PROJECT_SECTION_OVERHEAD_PX を導出した。
 *
 * ## 予算を締めたときの直接実測 (2026-09-05、統合ビュー時代)
 *
 * 測定元は Linux が PR #399 の CI e2e ジョブ (ubuntu-latest, job 101315107278 / run 33969397023、
 * head aa4dd7d。squash 後の main は 8fb4e8a だが、測定が走ったのはその前の PR head である。
 * Actions のログは既定 90 日で消えるので SHA を残す) のログ、macOS が
 * ローカルで `npx playwright test --config test/e2e/playwright.config.ts` を 2 回連続実行した結果
 * (完全一致) である。いずれも `grep -o 'MOBILE_SCROLL_RESIDUAL_MEASUREMENT=.*'` で抽出した。
 * `filterBar` は各行とも 54 (+ margin 4) で、tips は worst-case / first-card-worst-case-tip で
 * 198.81、tips-dismissed で 0 である。この表は「統合」が既定だった当時の値で、下の
 * PROJECT_SECTION_OVERHEAD_PX の節にある「分割」既定化後の実測 (bdboard-m070) と対になる。
 *
 * | platform | label                       | header | maxScrollY | nonDismissibleResidual |
 * |----------|-----------------------------|-------:|-----------:|-----------------------:|
 * | Linux    | worst-case-tip              |    243 |        328 |                  75.19 |
 * | Linux    | tips-dismissed              |    243 |        129 |                  75.00 |
 * | Linux    | first-card-worst-case-tip   |    243 |        328 |                  75.19 |
 * | macOS    | worst-case-tip              |    245 |        330 |                  77.19 |
 * | macOS    | tips-dismissed              |    245 |        131 |                  77.00 |
 * | macOS    | first-card-worst-case-tip   |    245 |        330 |                  77.19 |
 *
 * ## このガードが構造的に見ていないもの
 *
 * `body` / `#root` / `.app` の `min-height: 100vh` (いずれも `min-height: 100dvh` を併記)。`vh` は
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
  nonDismissibleResidualPx,
  pinTipsBannerRandom,
  reportResidualMeasurement,
  TIP_COUNT,
  waitForHeaderHeightConvergence,
} from './fixtures/mobile-chrome-helpers.js';

const MOBILE_VIEWPORT = { width: 375, height: 812 };

/**
 * 分割ビューのプロジェクトセクション1つぶんの、旧モデル (`-172`) が想定していなかった
 * 追加ドキュメント高。bdboard-m070 (2026-09-24)、ラウンド2の恒久対応。
 *
 * bdboard-mkm1.1 で既定ビューが「統合」から「分割」になり、`SplitBoard.tsx` が可視カードを
 * 1枚以上持つプロジェクトごとに
 *
 *   <section class="board-section">
 *     <h2 class="board-section-title">名前 (N件) [セッションバッジ] [ProjectHarnessBadges]</h2>
 *     <div class="lanes-scroll-region">…</div>
 *   </section>
 *
 * を積むようになった。カードが0枚のプロジェクトは `hasVisibleCards` (boardLanesHelpers.ts) で
 * セクションごと描画されない — このフィクスチャの2つ目のプロジェクト
 * (`.beads/e2e-empty-list` マーカーで list/gate を [] 固定、global-setup.ts 参照) がそれで、
 * 実測でも `.board-section` は常に1つしか現れない (`document.querySelectorAll('.board-section')`
 * で確認済み)。よってこのフィクスチャでは「プロジェクトセクション項」は常にちょうど1回ぶんで、
 * 旧モデルの `-172` (strip 44 + 固定パディング 44 + ヘッダー172ぶん) はこのラッパーが無かった
 * 前提の定数のままで成立する (`.lanes-row`/strip の実測値が web/src/styles/board.css の値と
 * 変わっていないことを確認済み)。新たに乗るのは
 *
 *   `.board-section-title` の border-box 高
 *     + そのタイトルの margin-bottom (12px、web/src/styles/board.css:29、CSS リテラル)
 *     + `.board-section` 自身の margin-bottom (28px、web/src/styles/board.css:4、CSS リテラル)
 *
 * の3項の合計。後ろ2つは固定だが、タイトル高はプロジェクト名・件数・セッションバッジ・
 * `ProjectHarnessBadges` (ハーネスパック名+状態+アクションボタンのチップが
 * `flex-wrap: wrap` で折り返す) の内容に依存し、CSS の定数だけでは決まらない
 * (ヘッダーや tips のような自身専用のラチェットがまだ無い)。
 *
 * 実測 (375x812, このフィクスチャの1件目のプロジェクト "fixture-project (11 件)
 * bdboard-harness 未導入 注入", 2026-09-24):
 *
 * | platform | titleHeight | overhead (title+12+28) | maxScrollY | nonDismissibleResidual |
 * |----------|------------:|------------------------:|-----------:|-----------------------:|
 * | macOS    |       50.95 |                    90.95 |        421 |                 168.19 |
 * | Linux CI |      (逆算) |                    65.19 |        393 |                 140.19 |
 *
 * (Linux CI は PR #684 の e2e ジョブ run 35950596098 / job 107478091508 の
 * `MOBILE_SCROLL_RESIDUAL_MEASUREMENT` ログから: header=243, tips=198.81, filterBar=58,
 * maxScrollY=393 → 旧モデル予測 327.81 との差分 65.19 が overhead。titleHeight はここから
 * 65.19 - 12 - 28 = 25.19 と逆算できる。)
 *
 * `.board-section-title` の line-height は 24.99px (getComputedStyle 実測)。macOS は
 * 50.95px ≈ 2 行、Linux CI は 25.19px ≈ 1 行 — 同一のタイトル文字列が、ちょうど折り返し境界を
 * またぐフォントメトリクスの差で macOS だけ2行になる。これは header の macOS/Linux 差
 * (245 / 243、連続的な数px差) とは種類が違う離散的な差なので、`+16px` のような小さい慣行
 * マージンでは足りない。
 *
 * PROJECT_SECTION_OVERHEAD_PX は**両プラットフォームで現に緑になっている今の最悪ケース
 * (macOS の2行) をそのまま採用**した:
 *
 *   51 (= ceil(50.95)、macOS 実測2行ぶんのタイトル高)
 *     + 12 (タイトル margin-bottom、CSS リテラル)
 *     + 28 (セクション margin-bottom、CSS リテラル)
 *     = 91
 *
 * ここへ「3行目ぶん」の追加 headroom を足さなかった理由: 下の MAX_PAGE_SCROLL_RESIDUAL_PX の
 * macOS 側の余裕 (450 - 421 = 29px) が、統合ビュー時代の余裕 (359 - 330 = 29px) と
 * 1px単位で一致する。これ以上緩めると、このラチェットの設計原則である「兄弟予算の合計」
 * よりも「今のところ壊れていない」ことを優先することになってしまう。将来ハーネスパックが
 * 増えてタイトルが3行目に折り返すようになったら、このラチェットが赤くなって知らせる
 * (プロジェクトセクションが本当に太ったという意図した検知であり、弱める理由にはならない)。
 */
const PROJECT_SECTION_OVERHEAD_PX = 91;

/**
 * ページスクロール残差の上限。
 *
 * **これは合成量の予算であり、実測 + 余裕では決められない。** 縛っている `maxScrollY` は
 * `header + tips + filterBarBox - 172 + projectSectionOverhead` で、構成要素のうち header と
 * tips には `mobile-header-compact.spec.ts` に専用のラチェットがある。よってこの上限は
 * **兄弟予算の合計を下回ってはならない**:
 *
 *   MAX_HEADER_HEIGHT_PX 250 + MAX_TIPS_BANNER_HEIGHT_PX 223 + filterBarBox 58
 *     + PROJECT_SECTION_OVERHEAD_PX 91 - 172 = 450
 *
 * 下回らせると、兄弟の名前付きアサーションが全部緑のまま**この 1 本だけが赤くなる窓**が
 * できる。特に MAX_TIPS_BANNER_HEIGHT_PX の +24px は「Linux でバナーが 1 行折り返す」ために
 * 専用に確保された、現状まるごと未使用の予算なので (mobile-header-compact.spec.ts:137-144)、
 * tips がその範囲で太るとちょうど窓に落ちる。引き金として現実的なのは
 * `docs/help-content.json` の編集で、HELP_TIPS はこの JSON を直読みしており、CLAUDE.md は
 * ヘルプ原本の追従を機能 PR に義務付けている。しかもそのとき出る失敗メッセージは下の
 * アサーションどおり「ヘッダー高・`.lane` の 260px リテラル・プロジェクトセクションの
 * 見出し」を疑えと言うので、原因 (ヘルプ文言) から遠い箇所を探させることになる。
 *
 * よって値は上の合計そのものを採る。直接実測はこの 450 に対する余裕の確認に使う
 * (bdboard-m070、2026-09-24、分割ビュー): worst-case は macOS Chromium 421px / Linux CI
 * 393px なので、より厳しい macOS 側で 29px の余裕、Linux 側で 57px の余裕。macOS 側の
 * 29px は統合ビュー時代 (359 - 330 = 29px) と1px単位で一致する — PROJECT_SECTION_OVERHEAD_PX
 * の節参照。Linux 側の余裕が広いのは意図的な緩和ではなく、このフィクスチャのタイトルが
 * Linux では1行にしか折り返らないという実測結果の反映。
 *
 * 400 では緩すぎた (統合ビュー時代): `.lane` の高さ上限を 60px 劣化させるミューテーション
 * (maxScrollY=390) が素通りしていた。450 はそれを捕まえる: macOS 実測 421 + 60 = 481 > 450、
 * Linux 実測 393 + 60 = 453 > 450 のどちらも予算を超える。**これ以上締めたいなら先に
 * MAX_TIPS_BANNER_HEIGHT_PX か PROJECT_SECTION_OVERHEAD_PX を締めること** — 兄弟が下がれば
 * 上の合計も下がり、ここも一緒に下げられる。順序を逆にすると上記の窓ができる。
 *
 * ここが回帰すると、モバイルでページ全体のスクロールとレーン内スクロールが奪い合い、
 * 指を置いた位置でどちらが動くか変わる帯が広がる。
 */
const MAX_PAGE_SCROLL_RESIDUAL_PX = 450;

/**
 * 「ユーザーが消せない」残差の上限 = maxScrollY から Tips と絞り込みバーの実測高を
 * 引いた残り。モデル上これは `header + filterBarMarginBottom - 172 + projectSectionOverhead`、
 * つまり**ヘッダー高とプロジェクトセクションの見出しぶん**を別角度から縛る (どちらも
 * 今のところユーザーが閉じたり畳んだりできない)。
 *
 * 上の予算だけだと、ヘッダーや `.lane` 上限・プロジェクトセクションが育っても Tips が
 * 短い日は吸収されて気付けない。こちらは Tips/絞り込みバーの高さを両辺から落とすので、
 * Tips の折り返し行数に鈍い。
 *
 * 根拠 (bdboard-m070、2026-09-24、分割ビュー): 実測最大は macOS の 168.19px (Linux は
 * 140.19px)。切り上げた 169px にリポジトリ慣行の +16px を足して **185**。旧予算
 * (bdboard-ij7g 当時、統合ビュー) は macOS 実測 77.19px + 16px = 94 だったので、+16px の
 * マージン幅自体は変えていない — macOS 側の余裕 (185 - 168.19 = 16.81px) は旧予算の
 * macOS 側の余裕 (94 - 77.19 = 16.81px) と小数点まで一致する。Linux 側の余裕は
 * 44.81px (185 - 140.19) で旧予算の Linux 側の余裕 18.81px より大きいが、これは
 * PROJECT_SECTION_OVERHEAD_PX の節で説明したとおり、このフィクスチャのタイトルが Linux
 * では1行にしか折り返らないという実測結果の反映であり、意図的な緩和ではない。
 *
 * 下限は MAX_HEADER_HEIGHT_PX = 250 と PROJECT_SECTION_OVERHEAD_PX = 91 から逆算する。
 * 既定の折りたたみ状態 (filterBar margin-bottom=4px) ではこの量は
 * `header - 168 + projectSectionOverhead` なので 250 - 168 + 91 = 173。このテストは下の
 * `test` 内のコメントどおり**折りたたみをあえて assert しない**ので、絞り込みバーが
 * 展開されたケース (`header - 164 + projectSectionOverhead` = 177) も上回る必要があるが、
 * 185 はどちらも上回る。それ未満まで締めると、ヘッダー太りやプロジェクトセクションの
 * 肥大を、それぞれの名前付きアサーションより先にこちらが落とし、失敗メッセージが
 * 原因から遠くなる。
 *
 * ここが回帰する経路は 3 つあり、症状が違う: `.lane` の 260px リテラル削り由来なら残差が
 * 増えてページ側とレーン内のスクロールが奪い合い、ヘッダー太り由来ならファーストカードが
 * 折り目より下へ押し出され (`.lane` の上限はレーンを下へ伸ばすだけで firstCardTop を
 * 動かさないので、後者はヘッダー経路でしか起きない)、プロジェクトセクションの見出しが
 * 太る (ハーネスバッジ増加・プロジェクト名長大化) 由来ならタイトル自体の折り返し行数が
 * 増える。
 */
const MAX_NON_DISMISSIBLE_RESIDUAL_PX = 185;

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
    const beforeConvergence = await waitForHeaderHeightConvergence(page);
    // 本文 (span) まで一致を見る。タイトルだけだと、pin が効いていても description が
    // 別の tip のままという壊れ方 (= バナー高さが worst-case にならない) を見逃す。
    await expect(page.locator('.tips-banner-text strong')).toHaveText(selectedTip.title);
    await expect(page.locator('.tips-banner-text span')).toHaveText(selectedTip.description);

    // 絞り込みバーの折りたたみは**あえて assert しない**。既定が展開へ戻ったら
    // (= bdboard-qxt1 の巻き戻し) それはヘルパーのエラーではなく残差の膨張として
    // 下の予算アサートに落としたい。
    const before = await measureResidual(page);
    const nonDismissibleResidual = nonDismissibleResidualPx(before);

    // 成功時にも実測値を残す (bdboard-ij7g)。CI ログを grep して Linux 実測を読み、
    // ラウンド 2 で予算を macOS/Linux 双方の直接実測に基づく値へ締める材料となった。
    await reportResidualMeasurement('worst-case-tip', before, {
      tipId: selectedTip.id,
      budgetMaxScrollY: MAX_PAGE_SCROLL_RESIDUAL_PX,
      maxScrollYHeadroom: Math.round((MAX_PAGE_SCROLL_RESIDUAL_PX - before.maxScrollY) * 100) / 100,
      budgetNonDismissibleResidual: MAX_NON_DISMISSIBLE_RESIDUAL_PX,
      nonDismissibleHeadroom:
        Math.round((MAX_NON_DISMISSIBLE_RESIDUAL_PX - nonDismissibleResidual) * 100) / 100,
      // bdboard-m070: 予算に組み込んだプロジェクトセクション項を実測 (before.projectSectionOverhead)
      // と並べて出す。両者の差が広がってきたら PROJECT_SECTION_OVERHEAD_PX を締め直す材料になる。
      projectSectionOverheadBudget: PROJECT_SECTION_OVERHEAD_PX,
      headerConvergedAfterMs: beforeConvergence.stableAfterMs,
      headerConvergenceQuietMs: beforeConvergence.quietMs,
      headerConvergenceSamples: beforeConvergence.samples,
      headerHeightVar: beforeConvergence.headerHeightVar,
      // `changes` は収束待ちを開始した後の変化履歴である。203 → 245 の折り返しは
      // `assertViewToolbarSettled` 完了時点で既に終わっているため、ここには現れない。
      // 初回サンプルと `--header-height` の 1 フレーム遅れにより、正常時も `245@0 245@16.7` の
      // ように同じ高さのエントリが 1〜2 個出る。異なる高さが並ぶときだけ待ち中に動いた証拠である。
      // ヘッダーを低く読んだ回 (203 のまま測った回) は、このフィールドではなくペイロードの
      // `header` フィールドで検知する (Linux CI ログで 203 と出れば一目で分かる)。
      headerHeightChanges: beforeConvergence.changes.join(' '),
    });

    expect(
      before.maxScrollY,
      `375x812: page scroll residual must stay within ${MAX_PAGE_SCROLL_RESIDUAL_PX}px — ` +
        `${describeResidualMetrics(before)}. ` +
        `ページ側に残るスクロール量が増えるほど「指を置いた位置でページとレーンのどちらが動くか」が` +
        `変わる帯が広がる。モデルは maxScrollY = header + tips + filterBarBox - 172 + ` +
        `projectSectionOverhead なので、増えたときはヘッダー高・.lane の 260px リテラル・` +
        `プロジェクトセクションの見出し (ハーネスバッジ等) を疑う。`,
    ).toBeLessThanOrEqual(MAX_PAGE_SCROLL_RESIDUAL_PX);

    expect(
      nonDismissibleResidual,
      `375x812: residual that the user cannot dismiss must stay within ` +
        `${MAX_NON_DISMISSIBLE_RESIDUAL_PX}px — actual=${nonDismissibleResidual.toFixed(2)} ` +
        `(${describeResidualMetrics(before)}). ` +
        `モデル上これは header + filterBar margin - 172 + projectSectionOverhead なので、` +
        `ヘッダーが太ったか、.lane の 260px 上限が削られたか、プロジェクトセクションの` +
        `見出しが育ったときにここへ出る。`,
    ).toBeLessThanOrEqual(MAX_NON_DISMISSIBLE_RESIDUAL_PX);

    // Tips を閉じると残差がその高さぶん実際に減ること = 残差が「消せるクローム」に
    // 帰属している証明。バナーが fixed 化したり跡地にプレースホルダが残ればここで落ちる。
    await page.getByRole('button', { name: 'Tipsを閉じる' }).click();
    await expect(page.locator('.tips-banner')).toHaveCount(0);
    const afterConvergence = await waitForHeaderHeightConvergence(page);
    const after = await measureResidual(page);

    const shrinkPx = before.maxScrollY - after.maxScrollY;
    await reportResidualMeasurement('tips-dismissed', after, {
      tipId: selectedTip.id,
      shrinkPx: Math.round(shrinkPx * 100) / 100,
      dismissedTipsHeight: before.tipsBanner,
      headerConvergedAfterMs: afterConvergence.stableAfterMs,
      headerConvergenceQuietMs: afterConvergence.quietMs,
      headerConvergenceSamples: afterConvergence.samples,
      headerHeightVar: afterConvergence.headerHeightVar,
      // `changes` は収束待ちを開始した後の変化履歴である。203 → 245 の折り返しは
      // `assertViewToolbarSettled` 完了時点で既に終わっているため、ここには現れない。
      // 初回サンプルと `--header-height` の 1 フレーム遅れにより、正常時も `245@0 245@16.7` の
      // ように同じ高さのエントリが 1〜2 個出る。異なる高さが並ぶときだけ待ち中に動いた証拠である。
      // ヘッダーを低く読んだ回 (203 のまま測った回) は、このフィールドではなくペイロードの
      // `header` フィールドで検知する (Linux CI ログで 203 と出れば一目で分かる)。
      headerHeightChanges: afterConvergence.changes.join(' '),
    });

    expect(
      shrinkPx,
      `375x812: dismissing the tips banner must remove its full height from the page ` +
        `scroll residual — shrink=${shrinkPx.toFixed(2)} but tipsHeight=${before.tipsBanner}. ` +
        `before: ${describeResidualMetrics(before)} / after: ${describeResidualMetrics(after)}`,
    ).toBeGreaterThanOrEqual(before.tipsBanner - 4);
  });
});
