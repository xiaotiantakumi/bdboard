import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * bdboard-h4xs.29: `header.css` の `.view-toolbar-left > * { white-space:
 * nowrap; }` は継承プロパティなので、`.view-toolbar-left` の子である
 * `.preset-control` の子孫にも伝わる。`.preset-control-popover`
 * (`width: 320px; overflow: hidden`、`settings-6.css`) の中にある空状態の
 * 案内文 (`.preset-control-empty`、`PresetControlListBody.tsx` の
 * 「プリセットはまだありません。いまの絞り込みを保存できます。」) や
 * 「…を上書き」ボタン (`.btn`、`PresetControlSaveFoot.tsx`。`white-space`
 * 未指定) がこの `nowrap` を継承し、折り返さずポップオーバー右端で
 * (省略記号も出ずに) 切れていた (375px/320px で実測、bdboard-h4xs.18 の
 * 検証時に発見)。
 *
 * `.preset-control-name`/`.preset-control-apply` などプリセット一覧の行側は
 * 自前で `white-space: nowrap` を明示しており、より近い宣言としてこの
 * ポップオーバーレベルの上書きより優先される (= 一覧行の省略記号つき
 * 切り詰めは変わらない。実ブラウザで確認済み、PR 本文)。
 *
 * `overflow-wrap: anywhere` も併記する: 「…を上書き」ボタンの中身
 * 「<プリセット名>」はプリセット名にスペースが無ければ折り返し不可能な
 * 1トークンになる (例: 38文字の英数字)。`white-space: normal` だけでは
 * 日本語の括弧境界 (」の前後) でしか折り返せず、英数字トークン自体は
 * ポップオーバーの右端をさらにはみ出して `overflow: hidden` に切られたままだった
 * (実測、375px)。`.preset-control-save-actions` は flex 行で、単純な
 * `overflow-wrap: break-word` は flex/grid の min-content 幅計算に効かず
 * はみ出しを防げない (`board-2.css` の `.card-title` のコメント参照)。
 * `anywhere` は min-content にも効くため、空白の無い長大トークンでも
 * 折り返してポップオーバー幅に収まる (実ブラウザで確認済み、PR 本文)。
 *
 * このルールを `responsive.css` の `@media (max-width: 700px)` の中に置くのは
 * 意図的 (`.chat-input::placeholder`、bdboard-h4xs.26/PR #742 と同じ理由付け)。
 * `.preset-control-popover` 自体は幅 320px 固定
 * (`max-width: calc(100vw - 32px)` は概ね 352px 未満のビューポートでしか
 * 効かない) なので、この `nowrap` 継承バグは実はデスクトップ幅でも再現する
 * (実ブラウザで確認済み。PR 本文)。ただしこのチケットの受け入れ基準はモバイル幅
 * (375px/320px) に限定されており、直し方の指針 (PR #742 のレビュー指摘: 実際に
 * バグが起きる範囲だけにスコープする) に従い、デスクトップ側の見た目を変えない
 * ようこの `@media` の外までは広げない。
 *
 * jsdom にはレイアウトが無く、折り返し・オーバーフローの有無をコンポーネント
 * テストで検証できないため、ここでは CSS を**テキストとして**読み、
 * `responsive.css` の `.preset-control-popover` 規則 (`@media (max-width:
 * 700px)` 内) に `white-space: normal` と `overflow-wrap: anywhere` の両方が
 * 揃っていること、かつ `settings-6.css` のベース規則 (media query の外) には
 * 付いていないことを固定する。実寸の確認 (折り返し・オーバーフロー解消、
 * デスクトップ幅無変化) は実ブラウザでの確認 (PR 本文) が担う。
 *
 * `responsive.css` の中にも `@media (max-width: 700px)` は1つしか無いが、
 * 他のファイル (`header-4.css`、`board-7.css`、`ticket-detail-9.css` など) にも
 * 同じ条件式の `@media` ブロックが複数あるため、resolveCssImports で連結した
 * index.css 全体からは「最初の `@media (max-width: 700px)`」を安全に一意に
 * 特定できない。そのため、ここでは対象の2ファイルを個別に直接読む。
 */
function readStyleFile(name: string): string {
  return readFileSync(
    fileURLToPath(new NodeUrl(`./styles/${name}`, import.meta.url)),
    'utf8',
  );
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

describe('index.css — .preset-control-popover のモバイル幅 nowrap 継承の解除 (bdboard-h4xs.29)', () => {
  const responsiveCss = readStyleFile('responsive.css');
  const settingsCss = readStyleFile('settings-6.css');

  // responsive.css には @media (max-width: 700px) が1つしか無く、この
  // ファイルの中に .preset-control-popover のベース規則(media query 外)は
  // 存在しないため、ここでの最初の一致がそのままモバイル用オーバーライド。
  const mobileBody = ruleBody(responsiveCss, '.preset-control-popover');
  // settings-6.css には @media が無く、.preset-control-popover のベース規則が
  // 1つだけあるため、ここでの一致はそのままベース規則。
  const baseBody = ruleBody(settingsCss, '.preset-control-popover');

  it('responsive.css の @media (max-width: 700px) 内に .preset-control-popover 規則が見つかる', () => {
    expect(
      mobileBody,
      '.preset-control-popover の規則が responsive.css の @media (max-width: 700px) 内に見つからない',
    ).not.toBeNull();
    expect(
      responsiveCss.includes('@media (max-width: 700px)'),
      'responsive.css から @media (max-width: 700px) が消えている',
    ).toBe(true);
  });

  it('white-space: normal が無いと空状態の案内文と「…を上書き」ボタンの文言が折り返さない', () => {
    expect(
      mobileBody,
      'white-space: normal が無いと .view-toolbar-left > * の nowrap を継承したまま',
    ).toMatch(/white-space\s*:\s*normal\b/);
  });

  it('overflow-wrap: anywhere が無いとスペースの無い長いプリセット名がポップオーバー右端をはみ出す', () => {
    expect(
      mobileBody,
      'overflow-wrap: anywhere が無いと flex 内の min-content 幅計算でボタンがはみ出しうる',
    ).toMatch(/overflow-wrap\s*:\s*anywhere\b/);
  });

  it('settings-6.css のベース規則(@media の外)には同じ上書きを置かない(デスクトップ幅の見た目を変えないため)', () => {
    expect(baseBody, '.preset-control-popover のベース規則(settings-6.css)が見つからない').not.toBeNull();
    expect(
      baseBody,
      'ベース規則(@media の外)に white-space: normal が付くと、デスクトップ幅でも見た目が変わってしまう',
    ).not.toMatch(/white-space\s*:\s*normal\b/);
    expect(
      baseBody,
      'ベース規則(@media の外)に overflow-wrap: anywhere が付くと、デスクトップ幅でも見た目が変わってしまう',
    ).not.toMatch(/overflow-wrap\s*:\s*anywhere\b/);
  });
});
