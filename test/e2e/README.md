# test/e2e

Playwright の E2E。`npm run test:e2e` (= `npm run build:web` してから
`playwright test --config test/e2e/playwright.config.ts`) で回す。**ルートに
`playwright.config.ts` は無い**ので `--config` は必須。この配下の相対 import は
`moduleResolution: node16` なので `.js` 拡張子を明示すること (省くと `error TS2835`)。

## テーマ (light / dark) の見かた

### 既定はライト。それは Playwright の仕様であって、このリポジトリの選択ではない

`playwright.config.ts` の `use` は `colorScheme` を指定していないが、それは
「OS 追従」ではなく**ライト固定**を意味する。Playwright 1.62.1 の
`node_modules/playwright/lib/index.js` で `colorScheme` フィクスチャが

```js
colorScheme: [({ contextOptions }, use) =>
  use(contextOptions.colorScheme === undefined ? 'light' : contextOptions.colorScheme), ...]
```

とライトへ解決され、その値が `_combinedContextOptions` にまとめられて
`page` フィクスチャにも、`runBeforeCreateBrowserContext` フック経由で手書きの
`browser.newContext()` にも back-fill される。`devices['Desktop Chrome']` は
`colorScheme` を持たないので上書きもされない。

つまり **`test.use({ colorScheme: 'dark' })` を書かないスペックはダークを一度も描画しない**。
bdboard-rr8m 以前はそれが全スペックに当てはまっていた。

### アプリのテーマは 2 状態しかない

`web/src/index.css` は

- `:root` — ライト
- `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }` — ダーク

の 2 つだけ。**`[data-theme='dark']` という規則は存在せず、`data-theme` を設定するコードも
アプリ側に無い**(`data-theme='light'` はダークを打ち消すための逃げ道として書式だけ用意されている)。
実測でも、ライトのメディア下で `document.documentElement.setAttribute('data-theme','dark')` を
しても `--color-bg` は `#f2f2f7` のまま変わらない。
**ダークを描画する手段は `prefers-color-scheme` の emulation だけ**で、`data-theme` を立てる
アプローチは効かない。

### どこまでをダーク/ライトで見るか

**全スペックの二重化はしない。**91 件を 2 テーマぶん回すと実行時間が倍になる一方、
大半のスペックが見ているのはレイアウト・スクロール・タップ標的サイズ・フォーカス順で、
どれもテーマトークンに依存しない。

代わりに `dark-theme.spec.ts` **1 本だけ**(4 テスト。suite 全体は 95 テスト / 31 ファイル)が
`test.use({ colorScheme: 'dark' })` / `test.use({ colorScheme: 'light' })` を持つ 2 本の
`test.describe` に分かれ、**ボード + チケット詳細パネル**(アプリで最も要素密度が高く、
トークンの利用箇所が集中している 2 画面)をそれぞれのテーマで掃引する。他の 91 件はライトの
まま残るので、**描画**としては suite 全体で両テーマが踏まれる。

#### コントラスト検査もライト・ダーク両方 (bdboard-97ib 以降)

bdboard-rr8m でダーク側の掃引を先に入れたときは、コントラスト検査もダークだけで、
ライトは一度も見ていなかった。bdboard-97ib で `runContrastSweep()` として掃引本体を
共通化し、`light theme (contrast sweep)` describe から同じロジックをライトでも回すように
した。

ライト側の初回実測 (2026-09-05、Chromium) は **sub-AA 18 セレクタ**
(`KNOWN_SUB_AA_LIGHT` 参照。bdboard-rr8m 時点の 20 件のうち bdboard-skde が 3 件を解消、
本チェンジで `.btn:disabled` 系 4 件を WCAG 1.4.3 の対象外として掃引から除外し、
無クラスだった `<span>` にクラスを与えて拾えるようになった 1 件を新規計上した内訳)。
残り 18 件を潰す棚卸しチケットは bdboard-97ib.1。ダーク側の `KNOWN_SUB_AA_DARK` は
bdboard-skde 以降空のまま。

掃引は要素の `opacity` (自身と、実効背景が確定するまでの祖先の累積値) を前景色の alpha に
合成してから比率を計算する。これが無いと `opacity` で薄めた前景を「濃い色のまま」誤判定し、
実描画より甘い比率を報告する (bdboard-skde の `.filter-chip-clear { opacity: 0.85 }` が
実例: 素の色だけなら 5.23:1 に見えるが実描画は 4.02:1 前後)。また `:disabled` の要素は
WCAG 2.2 Understanding SC 1.4.3 (非活性 UI コンポーネントは対象外) により掃引そのものから
除外する — `.btn:disabled { opacity: 0.5 }` は opacity を合成すると light/dark とも 4.5 未満に
なるが、これは意図した非活性表現であって「直すべき退行」ではない。

同じクラスの要素が複数箇所にあり、実効背景の違いで occurrence ごとに比率が変わる場合
(実測: `button.toggle-btn` が同一クラスで 4.4874:1 と 4.5428:1 の 2 通り) は、
**そのセレクタの全 occurrence の中で最悪の比率**を使って許可リストの stale/regressed 判定を
一度だけ行う。occurrence 単位で判定すると、複数箇所のうち 1 つだけ AA を満たした瞬間に
「陳腐化した」という誤検知になる。

掃引が**静止状態しか見ていない**ことの帰結は許可リストの件数だけではない。hover /
focus / ドラッグ中 / WIP 超過といった状態と、モバイル media query 下でしか現れる要素は、
許可リストが空でも一度もサンプルされない。実例は bdboard-bdsd (WIP 超過レーンの件数バッジが
ライト 1.66:1) と、`.lane-count` の静止 4.54:1 が hover で 4.22:1 まで落ちる件。

`dark-theme.spec.ts` の 4 テストの役割:

| テスト | 何を守るか | これ単独では何を見逃すか |
| --- | --- | --- |
| 「ダークで描画されている」 | Playwright の既定ライトに戻る退行そのもの。media query・トークン値・実際の `body` 背景の 3 経路で確認 | 個々の色の良し悪し |
| 「ダークで WCAG AA」 | ダーク側でコントラストが足りない色。既知の未達は `KNOWN_SUB_AA_DARK` に bd チケット ID と**実測値ベースの下限**付きで置き、下限割れ (= さらに悪化) でも AA 到達 (= エントリの陳腐化) でも落ちる。bdboard-skde 以降このリストは空 | 両テーマで同じ色に固定されている箇所 (コントラストは足りていれば通る)、および**静止状態以外** (hover / focus / ドラッグ中 / WIP 超過) |
| 「ライトで WCAG AA」 | 同じ掃引をライトで回す (bdboard-97ib)。既知の未達は `KNOWN_SUB_AA_LIGHT` (現在 18 件、棚卸しは bdboard-97ib.1) | 同上 (静止状態以外)。ダーク側だけの退行は見逃す (別テスト) |
| 「ライト/ダークで色が変わる」 | 片方のテーマに固定された色。未定義のカスタムプロパティを `var(--x, <固定色>)` で参照した箇所が典型 | コントラスト不足 (色は変わっているので通る) |

後ろ 3 つは互いを補完する。実際、ダークのトークンだけを暗くする変異ではダークのコントラスト
テストだけが落ち、色を固定する変異では複数のテストが落ちた。

### テーマ依存の強い画面を足したときは

`dark-theme.spec.ts` の `openBoardAndDetail()` に画面を足すか、同じ掃引を使う
テストを増やす。掃引は「そのとき描画されている可視要素すべて」を対象にするので、
画面を出しさえすれば対象は自動的に増える。

なお現在の掃引は**描画されている要素しか見ない**。フィクスチャで到達できない画面
(例: `.next-up-epic-section` は ready な epic が無いと出ない) は守れていない。

## この掃引で踏んだ落とし穴

新しく色を測るテストを書くときは、少なくともこの 5 つを踏まないこと。

1. **テーマを切り替えた直後の `getComputedStyle` は transition の開始値を返す。**
   `.toggle-btn` は `color` に 0.15s の transition を持つので、
   ライトとして採った値が実はダークの色、ということが起きる。
   `dark-theme.spec.ts` は採取前に `transition:none !important` を注入して凍結し、
   さらに `.toggle-btn` の色が確定値になっていることを毎回確かめている。
   **`prefers-reduced-motion: reduce` は代わりにならない** — index.css の
   reduced-motion ブロックは `*` に `transition-duration: 0.01ms` を当てるだけで
   `transition-property` は `all` のまま残るため、もともと transition が無かった要素にまで
   1 フレームの遅れを作る (`body` の背景で実測済み)。

2. **色は `rgb()` とは限らない。** index.css は `color-mix(in srgb, …)` を使っており
   (`.header` の背景など)、Chromium はその計算値を **`color(srgb 1 1 1 / 0.88)`** の形で、
   しかも成分を **0..1** で返す。「数値を順に 4 つ拾う」実装だと真っ白なヘッダーが
   `rgb(1,1,1)` = ほぼ黒として読まれ、見出しのコントラストが 1.02:1 と誤判定される
   (実際にそう書いて誤判定させた)。未知の形式は黙って通さず、失敗させること。

3. **2 回に分けて `querySelectorAll('*')` を叩くと対応付けがずれる。**
   詳細パネルは開いた直後に非同期でデータが届いて再レンダーするため、要素が 1 つ増減した
   時点で以降の添字が全部ずれる (445 件中 299 件しか一致しなくなった)。
   `dark-theme.spec.ts` は `evaluateHandle` で要素配列をページ内に固定し、
   **同じ配列**に対して 2 回採取したうえで、DOM の変化が止まるのを待ってから固定している。

4. **既知の未達の許可リストを「無条件に読み飛ばすセレクタの集合」にしない。**
   最初の実装がそれで、許可リストに載った 3 セレクタは**いくら悪化しても緑**だった
   (`.lane-count` をダーク限定で `#1b1b1d` = 約 1.05:1 の事実上不可視にしても 3 テストとも
   通った)。`KNOWN_SUB_AA_DARK` / `KNOWN_SUB_AA_LIGHT` は現在「セレクタ → 実測値から
   丸めた下限」を持ち、下限割れでも AA 到達でも落ちる。後者が無いと「直したのに
   許可リストから外し忘れる」状態に誰も気付けない (同じセレクタが複数箇所にあるときは
   全 occurrence 中の最悪比率で 1 回だけ判定する。`test/e2e/dark-theme.spec.ts` の
   `runContrastSweep()` 参照)。

5. **`Sample.color` は `opacity` を織り込まない。**(bdboard-97ib) `getComputedStyle().color`
   は要素の `opacity` が適用される前の色をそのまま返すので、`opacity: 0.85` の前景を
   「濃い色のまま」と誤判定して実描画より甘い比率を報告する
   (bdboard-skde の `.filter-chip-clear` が実例: 素の色だけなら 5.23:1 に見えるが実描画は
   4.02:1 前後)。`readSamples()` は要素自身から、実効背景が確定する祖先の手前までの
   `opacity` を累積し、前景の alpha に掛け合わせてから比率を計算する。あわせて `:disabled`
   の要素は掃引そのものから除外する — WCAG 2.2 Understanding SC 1.4.3 により非活性 UI
   コンポーネントの文字はコントラスト要件の対象外で、`.btn:disabled { opacity: 0.5 }` を
   opacity 込みで測ると light/dark とも 4.5 未満になるが、これは意図した非活性表現。
