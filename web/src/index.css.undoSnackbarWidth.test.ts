import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCssImports } from './testUtils/resolveCssImports';

/**
 * bdboard-h4xs.28: `.undo-snackbar` は `position: fixed; left: 50%;
 * transform: translateX(-50%);` で中央寄せしているが、`width` を指定していないと
 * width:auto の shrink-to-fit 計算の上限が「containing block 幅 − left」=
 * 画面幅の 50% になる (right が auto なので CSS 2.1 §10.3.7 のケース、
 * left+width+right の残りを margin ではなく width 自体の上限に使う)。
 * `max-width: min(480px, calc(100vw - 32px))` は上限を追加で絞るだけで、この
 * 50% 制約そのものは広げない。実機 (375px 幅) では「元に戻す」ボタンと ×
 * が横幅を取り、メッセージ欄が1文字ぶんしか残らず縦に折り返して細長い箱になった。
 *
 * `width: max-content` を足すと、ブラウザは shrink-to-fit の 50% 上限を無視して
 * 内容に合わせた幅を計算し、max-width が引き続き上限として効く (width と
 * max-width は別プロパティなので、宣言順に関わらず max-width が優先される)。
 *
 * jsdom にはレイアウトが無いため `UndoSnackbar` のコンポーネントテストは
 * `width` を消しても緑のまま通る。ここでは CSS を**テキストとして**読み、
 * `width: max-content` と既存の `max-width` の上限が両方とも `.undo-snackbar`
 * 規則に存在することを固定する。実寸の検証は実ブラウザでの確認 (PR 本文) が担う。
 */
function readCss(): string {
  return resolveCssImports(fileURLToPath(new NodeUrl('./index.css', import.meta.url)));
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * セレクタが完全一致するトップレベル規則の**宣言部**を返す。
 * セレクタは `,` を含まない単純なものだけを想定している (この規則群はすべてそう)。
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

describe('index.css — .undo-snackbar のモバイル幅レイアウト契約 (bdboard-h4xs.28)', () => {
  const css = readCss();
  const body = ruleBody(css, '.undo-snackbar');

  it('規則が見つかる', () => {
    expect(body, '.undo-snackbar の規則が見つからない').not.toBeNull();
  });

  it('width: max-content が無いと shrink-to-fit の上限が画面幅の50%になる', () => {
    expect(
      body,
      'width: max-content が無いと left:50% の containing block 計算で幅が画面の半分に縮み、モバイル幅でメッセージが1文字ずつ縦に折り返す',
    ).toMatch(/width\s*:\s*max-content\b/);
  });

  it('max-width の上限(480px または画面幅-32px)は維持する', () => {
    expect(
      body,
      'max-width が無いと広い画面で snackbar が際限なく伸びる',
    ).toMatch(/max-width\s*:\s*min\(\s*480px\s*,\s*calc\(\s*100vw\s*-\s*32px\s*\)\s*\)/);
  });
});
