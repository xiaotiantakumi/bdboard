# web/ フロントエンド実装で踏んだ非自明な罠

bd/git 運用規律ではなく、bdboard の `web/`（React + Vite）実装そのものに関する
技術的な知見。SKILL.md 本文の対象外（本文はあくまで「回し方の規律」）だが、この
プロジェクトで React/CSS を触るたびに再発しうるので別ファイルとして残す。

## `<details>` の子要素に無条件で `display` を指定すると、閉じていても常にレンダリングされる

症状: `<details>` に `open` 属性を付けていない（＝閉じている）のに、その中の
要素が見た目にも `getBoundingClientRect()` の実測でも常に表示され続ける。
`details` 自身の bounding box は `<summary>` 分の高さしかないのに、中身の
div がその外側まで描画され、**直後の兄弟要素と座標が重なる**。重なった座標では
DOM 順で後にある要素がクリックを奪う — ボタンが「見えているのに押せない」という
形で症状が出る（実測: bdboard-wkl, 2026-08-23。本番ビルドでチャットパネルの
スレッド切替トグルが押せない不具合として発現）。

原因: ブラウザの UA スタイルシートは `details:not([open]) > :not(summary)`
相当のセレクタで非表示（`display: none`）にしている。ここに詳細度で勝つ
author スタイル（例: `.some-body-class { display: flex; ... }` を `[open]`
スコープなしで書く）を当てると、その `display: none` が上書きされて閉じた
状態でも中身が出続ける。`position` や `overflow` は正常（`static`/`visible`）
なままなので、素朴に computed style を見ても「壊れていない」ように見える —
`element.closest('details').hasAttribute('open')` を確認して初めて気づく。

確認手順（再発時の切り分け）:

```js
const body = document.querySelector('.対象クラス');
const details = body.closest('details');
({
  isOpen: details.hasAttribute('open'),
  bodyVisible: body.getBoundingClientRect().height > 0,
});
// isOpen: false かつ bodyVisible: true ならこのパターン
```

クリックが奪われている実体は `document.elementFromPoint(x, y)` で確認できる
（押したい要素ではなく、重なっている別要素が返ってくる）。

対処: 中身の `display` を `[open]` スコープに限定する。

```css
.chat-panel-settings-body {
  display: none;              /* 既定は非表示 */
  flex-direction: column;
  ...
}
.chat-panel-settings[open] .chat-panel-settings-body {
  display: flex;              /* 開いているときだけ上書き */
}
```

ただし本当に details を折りたたみ式のまま直してよいか（＝デフォルトで
中身が隠れる見た目の変化を許容できるか）は UX 判断が要る。挙動を変えたくない
なら「details をやめて常時表示の div にする」側で直す方が安全なことが多い
（bdboard-wkl では、問題の要素自体が details に入れるべきでないナビゲーション
要素だったため、details の外に出す方で解決した。中身側の同種バグ自体は
bdboard-85j として別チケット化・未修正）。

## 「レンダーは走るのに DOM に出ない」謎は、まず本番ビルドで再現するか切り分ける

`npm run dev`（Vite dev server + React `<StrictMode>`）だけで再現し、
`vite build && vite preview` では再現しない場合、原因が StrictMode の
dev 専用 double-invoke（effect の mount→cleanup→再mount）や HMR の
古い状態に起因する「dev 環境だけの現象」である可能性が高い。逆に本番ビルド
でも再現するなら、実装そのもののバグとして扱ってよい（上の details バグは
このやり方で「StrictMode のせいではなく実バグ」と確定できた）。

切り分け手順:

```bash
cd web
npm run build            # tsc --noEmit も含む。型エラーはここで検出される
                          # (npm run build はサーバ側 src/ の tsc しか見ないため、
                          #  web/ の型エラーは npm run build だけでは検出できない —
                          #  プロジェクト CLAUDE.md の Build & Test 節参照)
npm run preview -- --port 4173
```

`vite preview` は `vite.config.ts` の `server.proxy`（`/api` → バックエンド）を
引き継ぐので、`/api/health` 等が 200 で返るか確認してからブラウザで再現テスト
すれば、dev server 特有のノイズを排除した状態で検証できる。
