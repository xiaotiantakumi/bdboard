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

## 複数マウントされる hook で module-scope の安定した関数参照を addEventListener に渡すと、重複登録されない

症状: 同じイベントリスナーを複数コンポーネント（同じ hook の複数インスタンス）が
それぞれ `addEventListener` で登録しているつもりが、実際には1つしか登録されて
いない。最初にマウント解除されたコンポーネントの `removeEventListener` が、
まだマウントされている他コンポーネント分も含めて全員のリスナーを道連れに消す
（実例: `useLaneStripHeightVar`、bdboard-1n0r / PR #319）。

原因: DOM 仕様の「同一の `(type, listener, capture)` の組は重複登録されない」
という規則。`useCallback` で安定化した参照や、hook の外（module scope）で
定義した関数をそのまま `addEventListener` に渡すと、複数のコンポーネント
インスタンスから見て「同じ listener」として扱われ、ブラウザ側が2個目以降の
登録を黙って無視する。エラーは出ない。

対処: 複数マウントされうる hook でグローバルなイベントを購読するときは、
**必ず effect ごとに新しいクロージャを作って渡す**。

```ts
useEffect(() => {
  const handle = () => shared(); // 呼び出し先が同じでも、参照はこの effect 専用
  window.addEventListener('resize', handle);
  return () => window.removeEventListener('resize', handle);
}, []);
```

`useCallback` で安定化した参照をそのまま渡すのは、意図（毎回同じ関数を使い
たい）と実際の挙動（ブラウザに重複登録として弾かれる）が逆転するので避ける。

## パスの左省略表示に `direction: rtl` を使うと bidi 並べ替えで誤読を招く

症状: 長いファイルパスを CSS だけで左側省略（`...` を先頭に出す）しようとして
`direction: rtl` を当てると、375px 幅の実機で `/Users/takumi/src/private_src/bdboard
(v2)` が `...vate_src/bdboard (v2)/` のように表示され、先頭の `/` が右端へ
回り込んで末尾スラッシュに見える（実測: bdboard-h4xs.8）。パス自体を誤読させる。

原因: `direction: rtl` は文字の描画順そのものを反転する bidi
（bidirectional text）制御であり、単なる省略記号の位置調整ではない。パス中の
`/` のような方向性のない文字も含めて並び順が変わるため、省略というより
「文字列全体を右から左に描画した結果、たまたま先頭が右端に来ている」状態になる。

対処: `direction: rtl` でごまかさず、**basename 表示 + `title` 属性にフルパス**
の組み合わせを使う。basename を取る関数は `web/src/api.ts` の
`projectNameFallback()` が既にあり、`LaneColumn` / `NextUpView` /
`dailyDigestMarkdown` が使っている既存慣例なので、新しい省略関数は書かず
これを再利用する。
