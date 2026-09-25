import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * bdboard-wmtb: デスクトップ幅 (例: 1440px) でも、`.preset-control-popover`
 * (`web/src/styles/settings-6.css`) の `width: 320px` は変わらない
 * (`max-width: calc(100vw - 32px)` は概ね 352px 未満のビューポートでしか効かない)。
 * `web/src/styles/header.css` の `.view-toolbar-left > * { white-space: nowrap; }`
 * の継承により、「…を上書き」ボタンの文言が(モバイル幅と同じ理由で)デスクトップ幅でも
 * 右端で切れていた。bdboard-h4xs.29 (PR #753) の `responsive.css` 内
 * `@media (max-width: 700px)` 限定の修正とは別に、`settings-6.css` の
 * `.preset-control-popover` ベース規則(@media の外、常時)に同じ2プロパティを足して
 * デスクトップ幅にも対応した。
 *
 * 併せて、popover 幅がビューポート非依存であることから、`.preset-control-rename .btn` /
 * `.preset-control-save-row .btn` の `white-space: nowrap` ガード(PR #753 の opus
 * レビューで見つかった、CJK ラベルの1文字折り返し回帰を防ぐもの)もデスクトップ幅向けに
 * `settings-6.css` 側へ複製した。
 *
 * jsdom にはレイアウトが無いため、ここでは `settings-6.css` を**テキストとして**読み、
 * `.preset-control-popover` ベース規則に `white-space: normal` と
 * `overflow-wrap: anywhere` が揃っていること、`.preset-control-rename .btn,
 * .preset-control-save-row .btn` 規則に `white-space: nowrap` が付いていること、
 * 一覧行の省略記号つき切り詰め(`.preset-control-name`)が変わっていないことを固定する。
 * 実寸の確認(折り返し・オーバーフロー解消、デスクトップ幅・モバイル幅とも)は実ブラウザでの
 * 確認(PR 本文)が担う。
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

function ruleBody(css: string, selector: string): string | null {
  const source = stripCssComments(css);
  const pattern = new RegExp(
    `(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`,
  );
  const match = source.match(pattern);
  return match === null ? null : match[2];
}

function ruleBodyForSelectorList(css: string, selectors: string[]): string | null {
  const source = stripCssComments(css);
  const escaped = selectors.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(^|[}\\n])\\s*${escaped.join('\\s*,\\s*')}\\s*\\{([^{}]*)\\}`);
  const match = source.match(pattern);
  return match === null ? null : match[2];
}

describe('index.css — .preset-control-popover のデスクトップ幅 nowrap 継承の解除 (bdboard-wmtb)', () => {
  const settingsCss = readStyleFile('settings-6.css');

  const popoverBody = ruleBody(settingsCss, '.preset-control-popover');
  const renameSaveButtonsBody = ruleBodyForSelectorList(settingsCss, [
    '.preset-control-rename .btn',
    '.preset-control-save-row .btn',
  ]);
  const nameBody = ruleBody(settingsCss, '.preset-control-name');

  it('.preset-control-popover 規則が settings-6.css に見つかる', () => {
    expect(popoverBody, '.preset-control-popover の規則が settings-6.css から消えている').not.toBeNull();
  });

  it('white-space: normal が無いとデスクトップ幅で「…を上書き」ボタンの文言が折り返さない', () => {
    expect(
      popoverBody,
      'white-space: normal が無いと .view-toolbar-left > * の nowrap をデスクトップ幅でも継承したまま',
    ).toMatch(/white-space\s*:\s*normal\b/);
  });

  it('overflow-wrap: anywhere が無いとスペースの無い長いプリセット名がデスクトップ幅でもポップオーバー右端をはみ出す', () => {
    expect(
      popoverBody,
      'overflow-wrap: anywhere が無いと flex 内の min-content 幅計算でボタンがはみ出しうる',
    ).toMatch(/overflow-wrap\s*:\s*anywhere\b/);
  });

  it('.preset-control-rename .btn / .preset-control-save-row .btn に white-space: nowrap が付いている(デスクトップ幅のCJK 1文字折り返し回帰防止)', () => {
    expect(
      renameSaveButtonsBody,
      '.preset-control-rename .btn, .preset-control-save-row .btn の規則が見つからない、または white-space: nowrap が付いていない',
    ).toMatch(/white-space\s*:\s*nowrap\b/);
  });

  it('.preset-control-name(一覧行の省略記号つき切り詰め)は変わらない', () => {
    expect(nameBody, '.preset-control-name の規則が settings-6.css から消えている').not.toBeNull();
    expect(nameBody).toMatch(/white-space\s*:\s*nowrap\b/);
    expect(nameBody).toMatch(/overflow\s*:\s*hidden\b/);
    expect(nameBody).toMatch(/text-overflow\s*:\s*ellipsis\b/);
  });
});
