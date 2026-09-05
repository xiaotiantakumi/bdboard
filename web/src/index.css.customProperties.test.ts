import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * jsdom のグローバル URL は Node の URL と別実装なので、CSS をファイルとして読むときは
 * node:url の URL を明示する。HygienePanel.badge-colors.test.ts と同じ読み方にする。
 */
function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new NodeUrl(relativePath, import.meta.url)),
    'utf8',
  );
}

const cssSource = readSource('./index.css');
// このテストファイル自身が web/src 直下にあるので、そのディレクトリがそのまま走査の起点になる。
const webSrcDir = fileURLToPath(new NodeUrl('.', import.meta.url));

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const RUNTIME_CUSTOM_PROPERTIES = new Set([
  // documentElement へ実行時に書かれる値。useHeaderHeightVar.ts、
  // useLaneStripHeightVar.ts、useBulkBarHeightVar.ts がそれぞれ管理する。
  '--header-height',
  '--lane-strip-height',
  '--bulk-bar-height',
  // usePopoverViewportClamp.ts が開いている各ポップオーバー要素の inline style に書く値。
  // index.css の .ai-quota-note-detail にも --popover-shift-x: 0px があるが、あれは
  // 祖先 (.ai-quota-popover) からの継承を打ち消すための防御的な再宣言であって値の出所では
  // ない (直上のコメント参照)。仮にあれを bare :root へ動かすと、:root は
  // .ai-quota-popover より継承チェーンの上流なので打ち消しが効かなくなり、親の inline
  // シフトが子に漏れて二重適用される。各ポップオーバー自身のシフトは inline 宣言が同一要素
  // で継承値に勝つので消えない。
  //
  // 上の 3 件 (documentElement 書き込み) とこの 1 件 (各ポップオーバー要素への書き込み) は
  // 書き込み先の要素が違う非対称な集合だが、下の
  // 「keeps RUNTIME_CUSTOM_PROPERTIES in sync with...」テストは書き込み先を
  // documentElement に絞らず `.style.setProperty('--...')` 呼び出し全般を走査するので、
  // この非対称を気にせず 1 つの集合として同じ assert に載せられる (bdboard-hzpw)。
  '--popover-shift-x',
]);

const SCOPED_CUSTOM_PROPERTIES = new Set([
  // .model-stats-table-scroller 上の値を、同要素の ::before / ::after のフェードだけが参照する。
  '--model-stats-fade-color',
  // .detail-panel.chat-panel 上の値を、その子孫の .chat-attachment 系が参照する。
  '--chat-attachment-preview-size',
]);

/**
 * 波かっこがブロックの区切り以外の場所に現れていないこと。
 *
 * collectDefinedCustomProperties は `{` / `}` を数えてブロックの深さを追うだけで、
 * 文字列リテラルも url() トークンも認識しない。`content: '{'` のような宣言が 1 つ入るだけで
 * 深さがずれ、以降の bare :root ブロックが「入れ子」と誤認されて定義集合から落ちる。落ちた
 * 結果は「未定義参照あり」の赤なので気付けはするが、原因がまったく別の場所に見えるので
 * ここで名指しで落とす。
 *
 * **url() を別扱いするのは、引用符なしで書けるから。** CSS Syntax L3 の url-token が禁じるのは
 * `"` `'` `(` `)` `\` と空白だけで、`{` `}` は通る。つまり `url(a}b)` は合法だが深さを 1 ずらし、
 * `@media (prefers-color-scheme: dark) { :root { … } }` が bare :root に昇格して**このファイルの
 * 検査が緑のまま素通りする**（PR #400 のレビューで実証された唯一の偽陰性経路）。文字列リテラル
 * 側は逆に赤へ倒れるので危険度が違う。
 *
 * 今日の index.css には引用符付き・url() とも該当が無いので、現状は前提の明文化。
 */
function bracesOutsideBlockDelimiters(css: string): string[] {
  const stringLiterals = css.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g) ?? [];
  const urlTokens = css.match(/url\([^)]*\)/gi) ?? [];
  return [...stringLiterals, ...urlTokens].filter(
    (token) => token.includes('{') || token.includes('}'),
  );
}

/**
 * `:root { --a: 1px; }` の `--a` を集める。深さ追跡なので、値そのものが `{}` ブロックの
 * カスタムプロパティ (`--a: { color: red };` — css-variables 的には合法) は取りこぼす。
 * 取りこぼしは「未定義参照あり」の赤になる安全側の失敗で、かつ index.css に前例が無い。
 */
function collectDefinedCustomProperties(css: string): Set<string> {
  const defined = new Set<string>();
  let blockDepth = 0;
  let topLevelHeader = '';
  let isBareRootBlock = false;
  let directDeclaration = '';

  const collectDirectDeclaration = () => {
    const match = directDeclaration.match(/^\s*(--[\w-]+)\s*:/);
    if (match) {
      defined.add(match[1]);
    }
    directDeclaration = '';
  };

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];

    if (character === '{') {
      if (blockDepth === 0) {
        // `:root, .foo` は :root にも適用されるが、全体トークンの定義場所としては曖昧なので
        // 数えない。ここでは条件なし・単独の bare `:root` だけを定義の正本にする。
        // 同じ理由で at-rule の中の `:root` も数えない。`@media` / `@supports` /
        // `@container` は条件付きなので当然だが、**無条件の `@layer` も弾いている** —
        // テーマ差は生まないので厳密には過剰だが、定義の provenance を「トップレベルの
        // bare :root だけ」に単純化しておくほうが読み手に優しい。`@property --x { … }` も
        // 同じ理由で定義には数えない (初期値の宣言であって値の出所ではない)。
        // いずれも今日の index.css には 1 件も無いので、現状は不活性。
        isBareRootBlock = topLevelHeader.trim() === ':root';
        directDeclaration = '';
        topLevelHeader = '';
      } else if (blockDepth === 1 && isBareRootBlock) {
        // bare :root 内の入れ子 at-rule / rule は条件なしの直接宣言ではない。
        directDeclaration = '';
      }
      blockDepth += 1;
      continue;
    }

    if (character === '}') {
      if (blockDepth === 1 && isBareRootBlock) {
        collectDirectDeclaration();
      }
      blockDepth -= 1;
      if (blockDepth === 0) {
        isBareRootBlock = false;
        directDeclaration = '';
        topLevelHeader = '';
      } else if (blockDepth === 1 && isBareRootBlock) {
        directDeclaration = '';
      }
      continue;
    }

    if (blockDepth === 1 && isBareRootBlock) {
      if (character === ';') {
        collectDirectDeclaration();
      } else {
        directDeclaration += character;
      }
    }

    if (blockDepth === 0) {
      if (character === ';') {
        topLevelHeader = '';
      } else {
        topLevelHeader += character;
      }
    }
  }

  return defined;
}

function collectReferencedCustomProperties(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]),
  );
}

/**
 * web/src 配下の *.ts / *.tsx を再帰的に列挙する（*.test.ts(x) は除外）。
 *
 * 除外理由: 現状どの *.test.ts(x) も `.style.setProperty(` を呼んでいない
 * (`.style.removeProperty(` の後始末呼び出しはあるが対象外)。テストファイルは
 * assert 対象のプロダクションコードそのものではないので、走査対象から外して
 * ノイズを減らす。将来テストが setProperty を呼ぶようになったら、このテストが
 * 検出漏れではなく「対象を広げる必要がある」というシグナルとして機能するよう、
 * 除外は拡張子パターンではなくここに明文化しておく。
 */
function listRuntimeSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entryName of readdirSync(dir)) {
    const fullPath = join(dir, entryName);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listRuntimeSourceFiles(fullPath));
      continue;
    }
    if (!/\.tsx?$/.test(entryName) || /\.test\.tsx?$/.test(entryName)) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

const SET_PROPERTY_CALL_PATTERN = /\.style\.setProperty\(\s*([^,)]+)\s*,/g;
const STRING_LITERAL_CUSTOM_PROPERTY = /^(['"])(--[\w-]+)\1$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

/**
 * 1 ファイル分の `<何か>.style.setProperty('--x', …)` 呼び出しから、書き込まれている
 * カスタムプロパティ名の集合を集める。
 *
 * **書き込み先の要素は問わない** (`documentElement.style` でも各ポップオーバー要素の
 * `el.style` でも同じ扱い)。これは手抜きではなく設計判断: RUNTIME_CUSTOM_PROPERTIES は
 * documentElement 書き込み 3 件とポップオーバー要素書き込み 1 件が混在した非対称な集合
 * なので (上のコメント参照)、書き込み先で絞ると 2 つの検査に分ける必要が出る。
 * `.style.setProperty` 全般を対象にすれば 1 つの assert で両方カバーできる。
 *
 * 第 1 引数が `'--foo'` のような文字列リテラルならそのまま採用する。
 * useLaneStripHeightVar.ts / useBulkBarHeightVar.ts のように `const CSS_VAR = '--foo'`
 * を経由する場合は、同じファイル内でその定数の宣言を逆引きする。
 * どちらの形にも当てはまらない呼び出しは見逃さず `unresolved` に積む —
 * ここで黙って読み飛ばすと、将来 3 つ目の書き方が増えたときに検出そのものが
 * 静かに無効化されてしまう。
 */
function collectSetPropertyTargets(
  filePath: string,
  fileSource: string,
  unresolved: string[],
): Set<string> {
  const targets = new Set<string>();
  for (const match of fileSource.matchAll(SET_PROPERTY_CALL_PATTERN)) {
    const rawArgument = match[1].trim();

    const literalMatch = rawArgument.match(STRING_LITERAL_CUSTOM_PROPERTY);
    if (literalMatch) {
      targets.add(literalMatch[2]);
      continue;
    }

    if (!IDENTIFIER_PATTERN.test(rawArgument)) {
      unresolved.push(
        `${filePath}: setProperty の第1引数を解釈できません (${rawArgument})`,
      );
      continue;
    }

    const constDeclarationPattern = new RegExp(
      `const\\s+${rawArgument}\\s*(?::[^=]+)?=\\s*(['"])(--[\\w-]+)\\1`,
    );
    const constMatch = fileSource.match(constDeclarationPattern);
    if (!constMatch) {
      unresolved.push(
        `${filePath}: 識別子 ${rawArgument} を --で始まる文字列リテラルの const 宣言に解決できません`,
      );
      continue;
    }
    targets.add(constMatch[2]);
  }
  return targets;
}

/**
 * web/src 配下すべての `.style.setProperty('--...')` 呼び出しから書き込み先の
 * カスタムプロパティ名を集める。テスト実行のたびにソースを読んで走査するので、
 * フックの削除・リネーム・新規追加のいずれにも追従する
 * (RUNTIME_CUSTOM_PROPERTIES 側にハードコードした期待値を書き足すだけでは、この
 * ズレを検出できない — bdboard-hzpw)。
 */
function collectRuntimeSetPropertyTargets(): {
  targets: Set<string>;
  unresolved: string[];
} {
  const unresolved: string[] = [];
  const targets = new Set<string>();
  for (const filePath of listRuntimeSourceFiles(webSrcDir)) {
    const fileSource = readFileSync(filePath, 'utf8');
    for (const target of collectSetPropertyTargets(
      filePath,
      fileSource,
      unresolved,
    )) {
      targets.add(target);
    }
  }
  return { targets, unresolved };
}

describe('index.css custom properties', () => {
  it('defines every referenced custom property in bare :root or a documented exception', () => {
    const sourceWithoutComments = stripCssComments(cssSource);
    const defined = collectDefinedCustomProperties(sourceWithoutComments);
    const referenced = collectReferencedCustomProperties(sourceWithoutComments);
    const allowedNonRootProperties = new Set([
      ...RUNTIME_CUSTOM_PROPERTIES,
      ...SCOPED_CUSTOM_PROPERTIES,
    ]);
    // フォールバック付き var() も許容しない。未定義参照は固定ライト色のフォールバックを
    // ダークテーマへ持ち込むなどの欠陥を隠すため、定義漏れとして必ず検出する。
    const undefinedProperties = [...referenced]
      .filter(
        (property) =>
          !defined.has(property) && !allowedNonRootProperties.has(property),
      )
      .sort();
    // ランタイム値もスコープ値も、参照がなくなったり bare :root のトークンになった時点で
    // 例外にしておく理由が消える。両方を同じ検査対象にして許可リストの陳腐化を防ぐ。
    const staleAllowedProperties = [...allowedNonRootProperties]
      .filter((property) => !referenced.has(property) || defined.has(property))
      .sort();

    expect(
      undefinedProperties,
      `index.css に bare :root で未定義のカスタムプロパティ参照があります: ${undefinedProperties.join(', ')}。全テーマ・全スコープで使う値は条件なしの単独 :root ブロックに定義し、要素スコープまたは実行時書き込みが意図的なら理由付きで許可リストに追加してください。":root, .foo { … }" のようなセレクタリストと at-rule (@media / @supports / @container / @layer) の中の :root は、意図的に定義として数えていません。`,
    ).toEqual([]);
    expect(
      staleAllowedProperties,
      `カスタムプロパティ許可リストに不要なエントリがあります: ${staleAllowedProperties.join(', ')}。var() 参照がなくなったか bare :root に定義されたため、許可リストから削除してください。`,
    ).toEqual([]);
  });

  it('keeps the brace-counting walker honest: no braces in string or url tokens', () => {
    const offenders = bracesOutsideBlockDelimiters(stripCssComments(cssSource));
    expect(
      offenders,
      `index.css の文字列リテラルまたは url() トークンに波かっこが入っています: ${offenders.join(', ')}。collectDefinedCustomProperties はどちらも認識せず波かっこを数えるだけなので、ブロックの深さがずれます。url() 側は深さが浅くなる向きにずれ、条件付き :root が bare :root に昇格してこのファイルの検査ごと緑で素通りします。トークン側を書き換えるか、walker に文字列リテラルと url() の読み飛ばしを実装してください。`,
    ).toEqual([]);
  });

  it('keeps RUNTIME_CUSTOM_PROPERTIES in sync with every .style.setProperty(\'--...\') call under web/src', () => {
    const { targets, unresolved } = collectRuntimeSetPropertyTargets();

    // 解決できなかった呼び出しがある時点で、以下の集合比較そのものが信用できない。
    // 「一致した」と誤って報告するより先に、走査ロジックの更新を要求して止める。
    expect(
      unresolved,
      `.style.setProperty('--...') 呼び出しを静的解析できませんでした。走査ロジック (collectSetPropertyTargets) を更新してください:\n${unresolved.join('\n')}`,
    ).toEqual([]);

    // 向き 1: 実際に書き込まれているのに許可リストに無い。書き込み先が新設され、
    // 許可リストの追従漏れがあるケース。
    const writtenButNotAllowed = [...targets]
      .filter((property) => !RUNTIME_CUSTOM_PROPERTIES.has(property))
      .sort();
    // 向き 2: 許可リストにあるのに、もう誰も setProperty していない。フックが削除・
    // リネームされ、許可リストだけが取り残されたケース (bdboard-hzpw の
    // useBulkBarHeightVar 削除シナリオそのもの)。このテストが無いと、この向きのズレは
    // 「許可リストに何を足しても黙って通る」窓口として残り続ける。
    const allowedButNotWritten = [...RUNTIME_CUSTOM_PROPERTIES]
      .filter((property) => !targets.has(property))
      .sort();

    expect(
      writtenButNotAllowed,
      `web/src で setProperty されているのに RUNTIME_CUSTOM_PROPERTIES に無いカスタムプロパティがあります: ${writtenButNotAllowed.join(', ')}。実行時に書き込まれる値は理由付きで RUNTIME_CUSTOM_PROPERTIES に追加してください。`,
    ).toEqual([]);
    expect(
      allowedButNotWritten,
      `RUNTIME_CUSTOM_PROPERTIES にあるのに web/src のどこからも setProperty されていないカスタムプロパティがあります: ${allowedButNotWritten.join(', ')}。値を書き込むフックが削除・リネームされた可能性があります (index.css 側の var() フォールバック値に固定される実害があります)。setProperty 呼び出しを復元するか、意図的な削除なら RUNTIME_CUSTOM_PROPERTIES からも削除してください。`,
    ).toEqual([]);
  });
});
