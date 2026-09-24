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
 * bdboard-mkm1.1 以降はこれに `PROJECT_SECTION_OVERHEAD_PX` (下記) が別枠のラチェットとして
 * 加わる — 詳細はその JSDoc 参照)。正体は固定パディングではなく**ヘッダーそのもの**で、
 * `kanban-mobile-lanes.spec.ts:69-70` の「maxScrollY はヘッダー高 H に比例する」と一致する。
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
 * 締め直す」手順で `PROJECT_SECTION_OVERHEAD_PX` を導出し、さらにラウンド 2 (レビュー指摘
 * 対応) で `projectSectionOverhead` を `reportResidualMeasurement` の payload に直接載せる
 * ようにしたので、以後は逆算ではなく実測値をそのまま grep できる。
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
 * `PROJECT_SECTION_OVERHEAD_PX` の節にある「分割」既定化後の実測 (bdboard-m070) と対になる。
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
 * 追加ドキュメント高に対する**専用のラチェット**。bdboard-m070 (2026-09-24)、ラウンド2の
 * 恒久対応 (レビュー指摘を受けたラウンド2改訂: 当初は下の2つの予算へ数値として合算するだけで
 * この項自体は未アサートだった — その設計だと「予算のかさ上げ」でしかなく、このチケットが
 * 明示的に禁じた「ラチェットを弱めずに数値だけ上げる」と実質同じになってしまうため、独立した
 * `expect` を持つ形に改めた)。
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
 * 実測でも `.board-section` は常に1つしか現れない。この前提は下の test 内で
 * `expect(page.locator('.board-section')).toHaveCount(1)` として明示的に確認している
 * (フィクスチャが将来2件目を可視化するように変わったら、この数値モデル自体が壊れるので
 * 予算アサーションより先にここで検知したい)。
 *
 * よってこのフィクスチャでは「プロジェクトセクション項」は常にちょうど1回ぶんで、旧モデルの
 * `-172` (strip 44 + 固定パディング 44 + ヘッダー172ぶん) はこのラッパーが無かった前提の
 * 定数のままで成立する (`.lanes-row`/strip の実測値が web/src/styles/board.css の値と
 * 変わっていないことを確認済み)。新たに乗るのは
 *
 *   `.board-section-title` の border-box 高
 *     + そのタイトルの margin-bottom (12px、web/src/styles/board.css:29、CSS リテラル)
 *     + `.board-section` 自身の margin-bottom (28px、web/src/styles/board.css:4、CSS リテラル)
 *
 * の3項の合計 (= `measureResidual` が返す `projectSectionOverhead`)。後ろ2つは固定だが、
 * タイトル高はプロジェクト名・件数・セッションバッジ・`ProjectHarnessBadges`
 * (ハーネスパック名+状態+アクションボタンのチップが `flex-wrap: wrap` で折り返す) の内容に
 * 依存し、CSS の定数だけでは決まらない。
 *
 * 実測 (375x812、このフィクスチャの1件目のプロジェクト "fixture-project (11 件)
 * bdboard-harness 未導入 注入"):
 *
 * | platform | titleHeight | projectSectionOverhead | maxScrollY | nonDismissibleResidual |
 * |----------|------------:|------------------------:|-----------:|-----------------------:|
 * | macOS (2026-09-24 ローカル)          | 50.95 | 90.95 | 421 | 168.19 |
 * | Linux CI (PR #688 run 35954956472 / job 107491192756) | (逆算25.98) | 64.98 | 393 | 140.19 |
 *
 * (Linux CI 値は当初 PR #684 の run から逆算していたが (65.19)、このラウンド 2 改訂で
 * `projectSectionOverhead` 自体を `reportResidualMeasurement` の payload に直接載せるように
 * したため、PR #688 自身の CI ログから実測値 64.98 をそのまま拾えるようになった —
 * 逆算 65.19 との差 0.21 は旧モデルの丸め誤差ぶん。)
 *
 * `.board-section-title` の line-height は 24.99px (getComputedStyle 実測)。macOS は
 * 50.95px ≈ 2 行、Linux CI は 25px 前後 ≈ 1 行 — 同一のタイトル文字列が、ちょうど折り返し境界を
 * またぐフォントメトリクスの差で macOS だけ2行になる。これは header の macOS/Linux 差
 * (245 / 243、連続的な数px差) とは種類が違う離散的な差である。
 *
 * `PROJECT_SECTION_OVERHEAD_PX` はこの実測worst-case (macOS の2行、ceil(90.95)=91) に、
 * 直接実測ベースの予算に対するリポジトリ慣行の余裕 `+16px` を足した
 *
 *   91 + 16 = 107
 *
 * を採る。この `+16px` は下の `MAX_NON_DISMISSIBLE_RESIDUAL_PX` の余裕幅 (旧予算 bdboard-ij7g
 * 当時: macOS 実測 77.19px に対し ceil(78)+16=94) と同じ慣行を踏襲したもの。
 * (レビュー前の版では余裕を足さず 91 をそのまま採っていたが、それだと macOS 実測 90.95 との
 * 差がわずか 0.05px しかなく、フォントレンダリングの微差で unrelated な PR が赤くなる
 * 実務上のリスクが高すぎた。)
 *
 * headroom は macOS 16.05px / Linux 42.02px。Linux 側が広いのは意図的な緩和ではなく、
 * このフィクスチャのタイトルが Linux では1行にしか折り返らないという実測結果の反映。
 * 将来ハーネスパックが増えてタイトルが3行目に折り返す (概算 +25px 前後、line-height 24.99px
 * ぶん) ようになれば、macOS 側の 16.05px headroom を超えてこのラチェットが赤くなって知らせる
 * (プロジェクトセクションが本当に太ったという意図した検知であり、弱める理由にはならない)。
 */
const PROJECT_SECTION_OVERHEAD_PX = 107;

/**
 * ページスクロール残差の上限。**旧モデル (統合ビュー時代) の値を寸分たがわず復元した値。**
 *
 * bdboard-mkm1.1 の分割ビュー既定化で `maxScrollY` に新たに乗った
 * `projectSectionOverhead` は、上の `PROJECT_SECTION_OVERHEAD_PX` という専用のラチェットで
 * 別枠として縛る。よってここで縛る量は測定値そのものではなく
 * **`before.maxScrollY - before.projectSectionOverhead`** — プロジェクトセクションの寄与を
 * 差し引いた、旧モデルが元々扱っていた量そのものである。
 *
 * **これは合成量の予算であり、実測 + 余裕では決められない。** 縛っているのは
 * `header + tips + filterBarBox - 172` で、構成要素のうち header と tips には
 * `mobile-header-compact.spec.ts` に専用のラチェットがある。よってこの上限は
 * **兄弟予算の合計を下回ってはならない**:
 *
 *   MAX_HEADER_HEIGHT_PX 250 + MAX_TIPS_BANNER_HEIGHT_PX 223 + filterBarBox 58 - 172 = 359
 *
 * 下回らせると、兄弟の名前付きアサーションが全部緑のまま**この 1 本だけが赤くなる窓**が
 * できる。特に MAX_TIPS_BANNER_HEIGHT_PX の +24px は「Linux でバナーが 1 行折り返す」ために
 * 専用に確保された、現状まるごと未使用の予算なので (mobile-header-compact.spec.ts:137-144)、
 * tips がその範囲で太るとちょうど窓に落ちる。引き金として現実的なのは
 * `docs/help-content.json` の編集で、HELP_TIPS はこの JSON を直読みしており、CLAUDE.md は
 * ヘルプ原本の追従を機能 PR に義務付けている。しかもそのとき出る失敗メッセージは下の
 * アサーションどおり「ヘッダー高・`.lane` の 260px リテラル」を疑えと言うので、原因
 * (ヘルプ文言) から遠い箇所を探させることになる。プロジェクトセクション由来の膨張は
 * この予算ではなく `PROJECT_SECTION_OVERHEAD_PX` に出るので、失敗メッセージが指す原因の
 * 範囲は統合ビュー時代と変わっていない。
 *
 * 値は 359 (統合ビュー時代の値をそのまま復元)。実測 (bdboard-m070、2026-09-24、分割ビュー、
 * `projectSectionOverhead` を差し引いた後): macOS 330.05px (余裕 28.95px)、Linux CI 328.02px
 * (余裕 30.98px)。これは統合ビュー時代の実測余裕 (359 - 330 = 29px、Linux 359 - 328 = 31px)
 * と 1px 未満の差でほぼ一致する — つまり `projectSectionOverhead` を専用ラチェットへ
 * 分離したことで、この予算の検知感度は分割ビュー導入前と実質的に変わっていない
 * (PR #684 の暫定値 450 はこの感度を大きく緩めてしまっていた: 実測ベースの余裕が
 * macOS 29px → 450-421=29px と偶然一致して見えたが、Linux は 450-393=57px まで緩んでおり、
 * CI がゲートする Linux 側の実効感度は統合ビュー時代の 31px からほぼ倍に劣化していた)。
 *
 * 400 では緩すぎた (統合ビュー時代): `.lane` の高さ上限を 60px 劣化させるミューテーション
 * (maxScrollY=390) が素通りしていた。359 はそれを捕まえる: macOS 実測 330.05 + 60 = 390.05 >
 * 359、Linux 実測 328.02 + 60 = 388.02 > 359 のどちらも予算を超える。**これ以上締めたいなら
 * 先に MAX_TIPS_BANNER_HEIGHT_PX を締めること** — 兄弟が下がれば上の合計も下がり、ここも
 * 一緒に下げられる。順序を逆にすると上記の窓ができる。
 *
 * ここが回帰すると、モバイルでページ全体のスクロールとレーン内スクロールが奪い合い、
 * 指を置いた位置でどちらが動くか変わる帯が広がる。
 */
const MAX_PAGE_SCROLL_RESIDUAL_PX = 359;

/**
 * 「ユーザーが消せない」残差の上限。**これも旧モデル (統合ビュー時代) の値を寸分たがわず
 * 復元した値**で、縛る量は `nonDismissibleResidual - before.projectSectionOverhead`
 * (= maxScrollY から Tips・絞り込みバー・プロジェクトセクション項を引いた残り)。
 * モデル上これは `header + filterBarMarginBottom - 172`、つまり**ヘッダー高だけ**を別角度から
 * 縛る (プロジェクトセクションぶんは上の `PROJECT_SECTION_OVERHEAD_PX` が既に担当している)。
 *
 * 上の `MAX_PAGE_SCROLL_RESIDUAL_PX` だけだと、ヘッダーや `.lane` 上限が育っても Tips が
 * 短い日は吸収されて気付けない。こちらは Tips/絞り込みバーの高さを両辺から落とすので、
 * Tips の折り返し行数に鈍い。
 *
 * 値は 94 (統合ビュー時代の値、bdboard-ij7g 当時の macOS 実測 77.19px に ceil して +16px の
 * リポジトリ慣行マージンを足したもの、をそのまま復元)。実測 (bdboard-m070、2026-09-24、
 * 分割ビュー、`projectSectionOverhead` を差し引いた後): macOS 77.24px (余裕 16.76px)、
 * Linux CI 75.21px (余裕 18.79px)。これも統合ビュー時代の実測余裕 (94 - 77.19 = 16.81px、
 * Linux 94 - 75.19 = 18.81px) と小数点以下 1 桁の差でほぼ一致する — `MAX_PAGE_SCROLL_RESIDUAL_PX`
 * と同じ理由で、この予算の検知感度も分割ビュー導入前から実質的に変わっていない。
 *
 * 下限は MAX_HEADER_HEIGHT_PX = 250 から逆算する。既定の折りたたみ状態
 * (filterBar margin-bottom=4px) ではこの量は `header - 168` なので 250 - 168 = 82。この
 * テストは下の `test` 内のコメントどおり**折りたたみをあえて assert しない**ので、絞り込み
 * バーが展開されたケース (`header - 164` = 86) も上回る必要があるが、94 はどちらも上回る。
 * それ未満まで締めると、ヘッダー太りを名前付きアサーションより先にこちらが落とし、失敗
 * メッセージが原因から遠くなる。
 *
 * ここが回帰する経路は 2 つあり、症状が違う: `.lane` の 260px リテラル削り由来なら残差が
 * 増えてページ側とレーン内のスクロールが奪い合い、ヘッダー太り由来ならファーストカードが
 * 折り目より下へ押し出される (`.lane` の上限はレーンを下へ伸ばすだけで firstCardTop を
 * 動かさないので、後者はヘッダー経路でしか起きない)。プロジェクトセクションの見出しが
 * 太る (ハーネスバッジ増加・プロジェクト名長大化) 由来の回帰は、この予算ではなく
 * `PROJECT_SECTION_OVERHEAD_PX` に出る。
 */
const MAX_NON_DISMISSIBLE_RESIDUAL_PX = 94;

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
    // bdboard-m070 ラウンド2: ProjectHarnessBadges は useQuery の非同期取得なので、
    // 描画完了を待たずに measureResidual すると projectSectionOverhead (タイトル高に
    // ハーネスバッジぶんが含まれるかどうか) がフレームごとにブレるレースになりうる。
    // このフィクスチャの1件目のプロジェクトは常にハーネスパックを持つので
    // (bdboard-harness 未導入・注入ボタン付き、PROJECT_SECTION_OVERHEAD_PX の JSDoc 参照)、
    // 可視化を明示的な条件として待つ。
    await expect(page.locator('.project-harness-badges').first()).toBeVisible({
      timeout: 15_000,
    });
    const beforeConvergence = await waitForHeaderHeightConvergence(page);
    // 本文 (span) まで一致を見る。タイトルだけだと、pin が効いていても description が
    // 別の tip のままという壊れ方 (= バナー高さが worst-case にならない) を見逃す。
    await expect(page.locator('.tips-banner-text strong')).toHaveText(selectedTip.title);
    await expect(page.locator('.tips-banner-text span')).toHaveText(selectedTip.description);

    // bdboard-m070: PROJECT_SECTION_OVERHEAD_PX / MAX_PAGE_SCROLL_RESIDUAL_PX /
    // MAX_NON_DISMISSIBLE_RESIDUAL_PX の数値モデルは「可視 .board-section は常にちょうど1つ」
    // を前提にしている (このフィクスチャの2つ目のプロジェクトは .beads/e2e-empty-list で
    // 空にしてあるため描画されない、global-setup.ts 参照)。この前提が崩れたら数値モデルごと
    // 壊れるので、予算アサーションより先にここで検知する。
    await expect(page.locator('.board-section')).toHaveCount(1);

    // 絞り込みバーの折りたたみは**あえて assert しない**。既定が展開へ戻ったら
    // (= bdboard-qxt1 の巻き戻し) それはヘルパーのエラーではなく残差の膨張として
    // 下の予算アサートに落としたい。
    const before = await measureResidual(page);
    const nonDismissibleResidual = nonDismissibleResidualPx(before);
    // bdboard-m070 ラウンド2: プロジェクトセクション項を差し引いた後の量。旧モデル
    // (統合ビュー時代) の 2 予算と直接比較できる形にするための分解 — 詳細は
    // MAX_PAGE_SCROLL_RESIDUAL_PX / MAX_NON_DISMISSIBLE_RESIDUAL_PX の JSDoc 参照。
    const maxScrollYWithoutProjectSection = before.maxScrollY - before.projectSectionOverhead;
    const nonDismissibleResidualWithoutProjectSection =
      nonDismissibleResidual - before.projectSectionOverhead;

    // 成功時にも実測値を残す (bdboard-ij7g)。CI ログを grep して Linux 実測を読み、
    // ラウンド 2 で予算を macOS/Linux 双方の直接実測に基づく値へ締める材料となった。
    await reportResidualMeasurement('worst-case-tip', before, {
      tipId: selectedTip.id,
      budgetProjectSectionOverhead: PROJECT_SECTION_OVERHEAD_PX,
      projectSectionOverheadHeadroom:
        Math.round((PROJECT_SECTION_OVERHEAD_PX - before.projectSectionOverhead) * 100) / 100,
      budgetMaxScrollYWithoutProjectSection: MAX_PAGE_SCROLL_RESIDUAL_PX,
      maxScrollYWithoutProjectSectionHeadroom:
        Math.round((MAX_PAGE_SCROLL_RESIDUAL_PX - maxScrollYWithoutProjectSection) * 100) / 100,
      budgetNonDismissibleResidualWithoutProjectSection: MAX_NON_DISMISSIBLE_RESIDUAL_PX,
      nonDismissibleResidualWithoutProjectSectionHeadroom:
        Math.round(
          (MAX_NON_DISMISSIBLE_RESIDUAL_PX - nonDismissibleResidualWithoutProjectSection) * 100,
        ) / 100,
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
      before.projectSectionOverhead,
      `375x812: split-view project section overhead must stay within ` +
        `${PROJECT_SECTION_OVERHEAD_PX}px — actual=${before.projectSectionOverhead.toFixed(2)} ` +
        `(${describeResidualMetrics(before)}). ` +
        `プロジェクトセクションの見出し (.board-section-title) が太った — プロジェクト名・` +
        `セッションバッジ・ハーネスバッジ (ProjectHarnessBadges) の折り返し行数が増えていないか疑う。`,
    ).toBeLessThanOrEqual(PROJECT_SECTION_OVERHEAD_PX);

    expect(
      maxScrollYWithoutProjectSection,
      `375x812: page scroll residual (minus the project-section overhead already covered by ` +
        `PROJECT_SECTION_OVERHEAD_PX) must stay within ${MAX_PAGE_SCROLL_RESIDUAL_PX}px — ` +
        `actual=${maxScrollYWithoutProjectSection.toFixed(2)} (${describeResidualMetrics(before)}). ` +
        `ページ側に残るスクロール量が増えるほど「指を置いた位置でページとレーンのどちらが動くか」が` +
        `変わる帯が広がる。モデルは maxScrollY = header + tips + filterBarBox - 172 + ` +
        `projectSectionOverhead なので、ここが増えたときはヘッダー高・.lane の 260px リテラルを疑う` +
        `(プロジェクトセクション由来なら上の projectSectionOverhead アサーションが先に落ちる)。`,
    ).toBeLessThanOrEqual(MAX_PAGE_SCROLL_RESIDUAL_PX);

    expect(
      nonDismissibleResidualWithoutProjectSection,
      `375x812: residual that the user cannot dismiss (minus the project-section overhead) ` +
        `must stay within ${MAX_NON_DISMISSIBLE_RESIDUAL_PX}px — ` +
        `actual=${nonDismissibleResidualWithoutProjectSection.toFixed(2)} ` +
        `(${describeResidualMetrics(before)}). ` +
        `モデル上これは header + filterBar margin - 172 なので、ヘッダーが太ったか、.lane の ` +
        `260px 上限が削られたときにここへ出る (プロジェクトセクション由来なら上の ` +
        `projectSectionOverhead アサーションが先に落ちる)。`,
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
