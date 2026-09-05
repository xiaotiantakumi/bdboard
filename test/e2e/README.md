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

### どこまでをダークで見るか

**全スペックの二重化はしない。**91 件を 2 テーマぶん回すと実行時間が倍になる一方、
大半のスペックが見ているのはレイアウト・スクロール・タップ標的サイズ・フォーカス順で、
どれもテーマトークンに依存しない。

代わりに `dark-theme.spec.ts` **1 本だけ**(3 テスト。suite 全体は 94 テスト / 31 ファイル)が
`test.use({ colorScheme: 'dark' })` を持ち、**ボード + チケット詳細パネル**(アプリで最も
要素密度が高く、トークンの利用箇所が集中している 2 画面)を掃引する。他の 91 件はライトの
まま残るので、**描画**としては suite 全体で両テーマが踏まれる。

#### ただしコントラスト検査はダークだけ。ライトは誰も見ていない

すぐ上の「両テーマが踏まれる」は**描画**の話であって、**コントラスト検査**の話ではない。
他の 91 件はライトで描画するだけで、色のコントラストは 1 か所も測っていない。
`dark-theme.spec.ts` の掃引をライトに倒して測ると sub-AA が大量に出る。bdboard-rr8m 時点の
実測は **20 セレクタ**で、bdboard-skde がそのうち 3 件を直したので現在は 17 前後のはずだが、
**再測していないので数字は信用しないこと**。ライト側のコントラストは依然**未検査**であり、
`KNOWN_SUB_AA` が現在 **0 件**なのは「ライトの状態が良いから」ではなく **ダークしか見て
いないから**である。ライトも守るなら、掃引をライト用にもう 1 本立て、実測値付きの許可リストに
積むところから始めることになる (bdboard-97ib)。

掃引が**ダーク・静止状態しか見ていない**ことの帰結は許可リストの件数だけではない。hover /
focus / ドラッグ中 / WIP 超過といった状態と、モバイル media query 下でしか現れる要素は、
許可リストが空でも一度もサンプルされない。実例は bdboard-bdsd (WIP 超過レーンの件数バッジが
ライト 1.66:1) と、`.lane-count` の静止 4.54:1 が hover で 4.22:1 まで落ちる件。

`dark-theme.spec.ts` の 3 テストの役割:

| テスト | 何を守るか | これ単独では何を見逃すか |
| --- | --- | --- |
| 「ダークで描画されている」 | Playwright の既定ライトに戻る退行そのもの。media query・トークン値・実際の `body` 背景の 3 経路で確認 | 個々の色の良し悪し |
| 「ダークで WCAG AA」 | ダーク側だけコントラストが足りない色。既知の未達は `KNOWN_SUB_AA` に bd チケット ID と**実測値ベースの下限**付きで置き、下限割れ (= さらに悪化) でも AA 到達 (= エントリの陳腐化) でも落ちる。bdboard-skde 以降このリストは空 | 両テーマで同じ色に固定されている箇所 (コントラストは足りていれば通る)、**ライト側のコントラスト全部**、および**静止状態以外** (hover / focus / ドラッグ中 / WIP 超過) |
| 「ライト/ダークで色が変わる」 | 片方のテーマに固定された色。未定義のカスタムプロパティを `var(--x, <固定色>)` で参照した箇所が典型 | コントラスト不足 (色は変わっているので通る) |

後ろ 2 つは互いを補完する。実際、ダークのトークンだけを暗くする変異ではコントラストのテストだけが
落ち、色を固定する変異では両方が落ちた。

### テーマ依存の強い画面を足したときは

`dark-theme.spec.ts` の `openBoardAndDetail()` に画面を足すか、同じ掃引を使う
テストを増やす。掃引は「そのとき描画されている可視要素すべて」を対象にするので、
画面を出しさえすれば対象は自動的に増える。

なお現在の掃引は**描画されている要素しか見ない**。フィクスチャで到達できない画面
(例: `.next-up-epic-section` は ready な epic が無いと出ない) は守れていない。

## この掃引で踏んだ落とし穴

新しく色を測るテストを書くときは、少なくともこの 4 つを踏まないこと。

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
   通った)。`KNOWN_SUB_AA` は現在「セレクタ → 実測値から丸めた下限」を持ち、
   下限割れでも AA 到達でも落ちる。後者が無いと「直したのに許可リストから外し忘れる」
   状態に誰も気付けない。
