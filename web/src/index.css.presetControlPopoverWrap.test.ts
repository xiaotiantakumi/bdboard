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
 * `.preset-control-name` (一覧行のプリセット名) と
 * `.preset-control-button-label` (トリガーボタンの文言) は自前で
 * `white-space: nowrap` を明示しており、より近い宣言としてこの
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
 * レビュー指摘 (opus) で見つかった追加の副作用: 上の `white-space: normal` は
 * `.preset-control-popover` の子孫すべてに継承されるため、新規保存フォーム
 * (`.preset-control-save-row` の「保存」「取消」) と行の名前変更フォーム
 * (`.preset-control-rename` の「決定」「取消」) の `.btn` ボタンも対象に
 * なってしまっていた。これらは日本語2文字でスペースを含まないラベルだが、
 * CJK の行分割規則では文字間どこでも改行できるため、`white-space: normal`
 * 化により automatic minimum size (min-content) が「単語まるごと」から
 * 「1文字ぶん」に縮み、320px 幅ではポップオーバー内の入力欄
 * (`flex: 1 1 auto`) に押されてボタンが「保」「存」のように1文字ずつ
 * 縦に割れて表示されていた (実測、320px)。これらのボタンは元々ここでは
 * 問題が起きていなかった (意図した修正対象は空状態の案内文と
 * 「…を上書き」ボタンだけ) ため、`.preset-control-rename .btn,
 * .preset-control-save-row .btn { white-space: nowrap; }` を追加して
 * 元の1行表示に戻す (実ブラウザで再確認済み、PR 本文)。
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
 * `responsive.css` の `@media (max-width: 700px)` ブロックを波括弧の対応で
 * 厳密に切り出した上で、その中にある `.preset-control-popover` 規則に
 * `white-space: normal` と `overflow-wrap: anywhere` の両方が揃っていること、
 * `.preset-control-rename .btn, .preset-control-save-row .btn` 規則に
 * `white-space: nowrap` が付いていること、かつ `settings-6.css` のベース規則
 * (media query の外) にはこれらが付いていないことを固定する。ブロックを
 * 波括弧の対応で厳密に切り出すのは、単純な部分一致だと `.preset-control-popover`
 * 規則が (誤って) `@media` の外に移動していても「ファイルのどこかに
 * `@media (max-width: 700px)` という文字列がある」だけで誤って合格してしまう
 * ため (実際に規則を `@media` の外へ動かしても4件中2件が通ってしまうことを
 * レビューで指摘された)。実寸の確認 (折り返し・オーバーフロー解消、
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
 * セレクタは `,` を含まない単純なものだけを想定している。
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

/**
 * カンマ区切りの複数セレクタからなる規則の**宣言部**を返す。セレクタ間の
 * 改行・インデントの揺れを許容するため、`selectors` の各要素はそのままの
 * 並び順で、要素間に任意の空白 (改行含む) を許して一致させる。
 */
function ruleBodyForSelectorList(css: string, selectors: string[]): string | null {
  const source = stripCssComments(css);
  const escaped = selectors.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(^|[}\\n])\\s*${escaped.join('\\s*,\\s*')}\\s*\\{([^{}]*)\\}`);
  const match = source.match(pattern);
  return match === null ? null : match[2];
}

/**
 * `css` の中から `@<prefix> ... {` で始まる at-rule ブロックを、波括弧の
 * 対応を数えて厳密に切り出し、その中身 (外側の `{`/`}` を除く) を返す。
 * 単純な部分文字列検索と違い、ネストした `{}` を正しく跨いで対応する `}` を
 * 見つけるため、「ブロックの中にあるはずの規則が実際に中にあるか」を
 * 部分一致より強く検証できる。見つからなければ null。
 */
function extractAtRuleBlock(css: string, atRulePrefix: string): string | null {
  const source = stripCssComments(css);
  const startIdx = source.indexOf(atRulePrefix);
  if (startIdx === -1) {
    return null;
  }
  const braceStart = source.indexOf('{', startIdx);
  if (braceStart === -1) {
    return null;
  }
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(braceStart + 1, i);
      }
    }
  }
  return null;
}

describe('index.css — .preset-control-popover のモバイル幅 nowrap 継承の解除 (bdboard-h4xs.29)', () => {
  const responsiveCss = readStyleFile('responsive.css');
  const settingsCss = readStyleFile('settings-6.css');

  // 波括弧の対応で @media (max-width: 700px) ブロックの中身だけを切り出す。
  // 以降のルール検索はこのブロック文字列の中だけを対象にするので、対象の
  // 規則が @media の外に移動していれば mediaBlock 内では見つからず、
  // テストは(部分一致に頼らず)確実に落ちる。
  const mediaBlock = extractAtRuleBlock(responsiveCss, '@media (max-width: 700px)');

  const mobilePopoverBody = mediaBlock === null ? null : ruleBody(mediaBlock, '.preset-control-popover');
  const mobileButtonsBody =
    mediaBlock === null
      ? null
      : ruleBodyForSelectorList(mediaBlock, ['.preset-control-rename .btn', '.preset-control-save-row .btn']);

  // settings-6.css には @media が無く、.preset-control-popover のベース規則が
  // 1つだけあるため、ここでの一致はそのままベース規則。
  const basePopoverBody = ruleBody(settingsCss, '.preset-control-popover');

  it('responsive.css の @media (max-width: 700px) ブロックが見つかる', () => {
    expect(
      mediaBlock,
      'responsive.css から @media (max-width: 700px) ブロックが消えている(または波括弧が対応していない)',
    ).not.toBeNull();
  });

  it('.preset-control-popover 規則が @media (max-width: 700px) ブロックの中に見つかる', () => {
    expect(
      mobilePopoverBody,
      '.preset-control-popover の規則が responsive.css の @media (max-width: 700px) ブロックの中に見つからない(@media の外に移動していないか確認)',
    ).not.toBeNull();
  });

  it('white-space: normal が無いと空状態の案内文と「…を上書き」ボタンの文言が折り返さない', () => {
    expect(
      mobilePopoverBody,
      'white-space: normal が無いと .view-toolbar-left > * の nowrap を継承したまま',
    ).toMatch(/white-space\s*:\s*normal\b/);
  });

  it('overflow-wrap: anywhere が無いとスペースの無い長いプリセット名がポップオーバー右端をはみ出す', () => {
    expect(
      mobilePopoverBody,
      'overflow-wrap: anywhere が無いと flex 内の min-content 幅計算でボタンがはみ出しうる',
    ).toMatch(/overflow-wrap\s*:\s*anywhere\b/);
  });

  it('.preset-control-rename .btn, .preset-control-save-row .btn 規則が @media (max-width: 700px) ブロックの中に見つかる', () => {
    expect(
      mobileButtonsBody,
      '.preset-control-rename .btn, .preset-control-save-row .btn の規則が responsive.css の @media (max-width: 700px) ブロックの中に見つからない',
    ).not.toBeNull();
  });

  it('white-space: nowrap が無いと「保存」「取消」「決定」ボタンが320px幅で1文字ずつ折り返す(CJK 2文字ラベルの回帰)', () => {
    expect(
      mobileButtonsBody,
      'white-space: nowrap が無いと .preset-control-popover から継承した white-space: normal のせいで、日本語2文字ラベルが min-content 計算で1文字幅に縮み折り返しうる',
    ).toMatch(/white-space\s*:\s*nowrap\b/);
  });

  it('settings-6.css のベース規則(@media の外)には同じ上書きを置かない(デスクトップ幅の見た目を変えないため)', () => {
    expect(basePopoverBody, '.preset-control-popover のベース規則(settings-6.css)が見つからない').not.toBeNull();
    expect(
      basePopoverBody,
      'ベース規則(@media の外)に white-space: normal が付くと、デスクトップ幅でも見た目が変わってしまう',
    ).not.toMatch(/white-space\s*:\s*normal\b/);
    expect(
      basePopoverBody,
      'ベース規則(@media の外)に overflow-wrap: anywhere が付くと、デスクトップ幅でも見た目が変わってしまう',
    ).not.toMatch(/overflow-wrap\s*:\s*anywhere\b/);
  });
});
