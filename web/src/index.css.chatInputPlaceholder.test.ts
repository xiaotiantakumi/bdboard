import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCssImports } from './testUtils/resolveCssImports';

/**
 * bdboard-h4xs.26: `.chat-input` のプレースホルダー文言
 * (`ChatComposer.tsx` の「例: in_progress のまま止まっているチケットを教えて」)は、
 * モバイル幅ではモバイル向けの固定高 (`chat-3.css` の 46px /
 * `responsive.css` の 48px。どちらも 16px フォント・line-height 1.45 の
 * 1行ぶんしか無い) の中で2行に折り返し、2行目の上半分だけが `overflow-y: auto`
 * の外に出て見えていた (文字が縦に半分だけ欠けるので読みにくい)。
 *
 * `.chat-input` 自体の高さを変えると bdboard-h4xs.15 / bdboard-iglk が
 * 実測で導出した縦予算 (`.chat-messages` に残す余白の計算) が崩れるため、
 * ここでは高さ側ではなく `::placeholder` 側を1行に収める。
 * `white-space: nowrap` で折り返しを止め、`overflow: hidden` +
 * `text-overflow: ellipsis` で入力欄の幅を超えた分だけを切る。デスクトップ幅
 * では元々1行に収まっているため見た目は変わらない (PR 本文の実ブラウザ確認)。
 *
 * jsdom にはレイアウトが無く、`::placeholder` の折り返し有無を
 * コンポーネントテストで検証できないため、ここでは CSS を**テキストとして**
 * 読み、3つの宣言が `.chat-input::placeholder` 規則に揃っていることを固定する。
 * 実寸の確認 (2行折り返し→1行への変化) は実ブラウザでの確認 (PR 本文) が担う。
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
    // 先読み否定で `overflow-x:`/`overflow-y:` の末尾に誤って一致しないようにする
    // (別プロパティで、テキストの折り返し防止という直し方の検証にはならない)。
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
