import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCssImports } from './testUtils/resolveCssImports';

/**
 * bdboard-h4xs.26: `.chat-input` のプレースホルダー文言
 * (`ChatComposer.tsx` の「例: in_progress のまま止まっているチケットを教えて」)は、
 * `@media (max-width: 700px)` の中でだけ `.chat-input` が固定高になる
 * (`responsive.css` の 48px。576px 以下の短い縦幅では `chat-3.css` がさらに
 * 46px へ上書き。どちらも 16px フォント・line-height 1.45 の1行ぶんしか無い)
 * ため、その範囲の幅で2行に折り返すと、2行目の上半分だけが `overflow-y: auto`
 * の外に出て見えていた (文字が縦に半分だけ欠けるので読みにくい)。
 *
 * `.chat-input` 自体の高さを変えると bdboard-h4xs.15 / bdboard-iglk が
 * 実測で導出した縦予算 (`.chat-messages` に残す余白の計算) が崩れるため、
 * ここでは高さ側ではなく `::placeholder` 側を1行に収める。
 * `white-space: nowrap` で折り返しを止め、`overflow: hidden` +
 * `text-overflow: ellipsis` で入力欄の幅を超えた分だけを切る。
 *
 * この `.chat-input::placeholder` 規則は `responsive.css` の
 * `@media (max-width: 700px)` の中に置く(意図的。opus レビュー指摘、PR #742)。
 * デスクトップ幅(700px超)では `.chat-input` は固定高にならず、かつサイド
 * パネルは `useResizableSidePanel` で 360〜720px の間にユーザーがドラッグで
 * 狭められる。パネル幅を最小付近まで狭めるとプレースホルダーが1行に収まらない
 * ことがあるが、その場合は2行とも欠けずに全文が読める(今回の固定高バグ自体が
 * 無いため)。`::placeholder` のルールを `@media` の外まで広げると、その
 * 「2行とも全文読める」デスクトップ側の見た目まで1行切り詰めに変えてしまう
 * (media query の外での desktop 幅の見た目維持は PR 本文の実ブラウザ確認)。
 *
 * `text-overflow: ellipsis` は Chrome (152, headless 実測) では
 * `getComputedStyle(el, '::placeholder').textOverflow` が `clip` を返し、
 * 省略記号(…)は描画されずに単純クリップになる (`<textarea>` の
 * `::placeholder` に対するエンジン差と見られる)。WebKit / Firefox では
 * 省略記号が描画されることを opus レビューが確認済み(iOS Safari は WebKit
 * 系なので実機ではこちらの見た目になる見込み)。Chrome でも `white-space:
 * nowrap` + `overflow: hidden` は効くため、報告された「2行目が縦に半分だけ
 * 欠けて読みにくい」症状はどのエンジンでも解消する。
 *
 * jsdom にはレイアウトが無く、`::placeholder` の折り返し有無を
 * コンポーネントテストで検証できないため、ここでは CSS を**テキストとして**
 * 読み、3つの宣言が `.chat-input::placeholder` 規則に揃っていることを固定する。
 * 実寸の確認 (2行折り返し→1行への変化、デスクトップ幅無変化) は実ブラウザでの
 * 確認 (PR 本文) が担う。
 */
function readCss(): string {
  return resolveCssImports(fileURLToPath(new NodeUrl('./index.css', import.meta.url)));
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * セレクタが完全一致するトップレベル規則の**宣言部**を返す。
 * セレクタは `,` を含まない単純なものだけを想定している (この規則がそう)。
 * 見つからなければ null を返し、呼び出し側で「規則ごと消えた/改名された」として落とす。
 */
function ruleBody(css: string, selector: string): string | null {
  const source = stripCssComments(css);
  const pattern = new RegExp(
    `(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`,
  );
  const match = source.match(pattern);
  return match === null ? null : match[2];
}

describe('index.css — .chat-input::placeholder の1行固定 (bdboard-h4xs.26)', () => {
  const css = readCss();
  const body = ruleBody(css, '.chat-input::placeholder');

  it('規則が見つかる', () => {
    expect(body, '.chat-input::placeholder の規則が見つからない').not.toBeNull();
  });

  it('white-space: nowrap が無いと入力欄の幅を超えた分が折り返し、固定高の中で2行目が欠ける', () => {
    expect(
      body,
      'white-space: nowrap が無いとプレースホルダーが複数行に折り返しうる',
    ).toMatch(/white-space\s*:\s*nowrap\b/);
  });

  it('overflow: hidden が無いとはみ出した1行分がボックス外にそのまま描画される', () => {
    // 先読み否定 (?<![\w-]) は「text-overflow: hidden」のような値が将来
    // 書かれた場合に、その `overflow: hidden` 部分文字列へ誤って一致しない
    // ようにするためのもの (text- の直後の overflow は `-` を直前に持つので
    // 除外される)。`overflow-x:`/`overflow-y:` はプロパティ名自体が違うため
    // この lookbehind の有無に関わらずそもそも一致しない。
    expect(
      body,
      'overflow: hidden が無いと nowrap ではみ出した分がクリップされない',
    ).toMatch(/(?<![\w-])overflow\s*:\s*hidden\b/);
  });

  it('text-overflow: ellipsis が無いと切れた末尾が省略記号なしで唐突に終わる', () => {
    expect(
      body,
      'text-overflow: ellipsis が無いとはみ出した末尾の切れ方が唐突になる',
    ).toMatch(/text-overflow\s*:\s*ellipsis\b/);
  });
});
