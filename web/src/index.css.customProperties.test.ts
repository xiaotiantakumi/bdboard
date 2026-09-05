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
 * web/src 配下の *.ts / *.tsx を再帰的に列挙する。**テストコードは除外する** —
 * 拡張子で判る *.test.ts(x) と、共有ヘルパーが住む web/src/test/ ディレクトリの両方。
 *
 * **この除外は意図的な設計であり、広げてはならない。** 下の「向き 2」は
 * 「RUNTIME_CUSTOM_PROPERTIES にあるのに誰も setProperty していない」を検出することで
 * フックの削除・リネームを捕まえるが、走査対象にテストコードが入っていると、
 * **テスト側のフィクスチャ書き込み 1 行がプロダクションのフック削除を丸ごと覆い隠す**。
 * 「テストも setProperty を呼ぶようになったら対象を広げよう」という判断は、
 * このチケット (bdboard-hzpw) が塞ごうとしている当の穴を開け直すことになる。
 * 逆に「向き 1」(書き込まれているのに許可リストに無い) をテストコードへ適用したい
 * 動機も無い — テストが一時的に書く値は index.css の定義とは無関係だからである。
 *
 * web/src/test/ を明示的に外す必要があるのは、そこの共有ヘルパー
 * (appHarness.tsx / axe.ts / fakeHistory.ts / popoverViewportClampTestHelpers.ts /
 * tunnelFetchMock.ts) がファイル名に .test. を含まないため。2026-09-05 時点で
 * どれも setProperty を呼んでいないので今は無風だが、上記の理由により
 * フィクスチャが書き始めた「後」に足したのでは手遅れになる。
 */
function listRuntimeSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entryName of readdirSync(dir)) {
    const fullPath = join(dir, entryName);
    if (statSync(fullPath).isDirectory()) {
      if (entryName === 'test') {
        continue;
      }
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

/**
 * JS/TS ソースからコメントを取り除く（文字列リテラルとテンプレートリテラルの中身は残す）。
 *
 * 必要な理由: コメントアウトされた `.style.setProperty('--x', …)` を実際の書き込みと
 * 数えてしまうと、フックを消してコメントとして残した瞬間に「向き 2」が黙って緑になる。
 * それはこのテストが塞ぐはずの穴そのものである。
 *
 * 正規表現一発で消さないのは、`'https://…'` のような文字列の中の `//` を行コメントの
 * 開始と誤認して以降を丸ごと捨てるため。状態機械で文字列を跨がないようにしている。
 *
 * **正規表現リテラルは追跡していない**（`/['"]/` のようにクォートを含むものがあると
 * 状態がずれうる）。ただしこの取りこぼしの向きは安全側である: ずれて本物の
 * setProperty 呼び出しを飲み込んだ場合、その値は「向き 2」で allowedButNotWritten に
 * 落ちてテストが**赤くなる**。黙って緑になる方向には壊れない。
 */
function stripJsComments(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const character = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') {
        state = 'line';
        i += 1;
      } else if (character === '/' && next === '*') {
        state = 'block';
        i += 1;
      } else {
        if (character === "'" || character === '"' || character === '`') {
          state = character;
        }
        out += character;
      }
      continue;
    }
    if (state === 'line') {
      if (character === '\n') {
        state = 'code';
        out += character;
      }
      continue;
    }
    if (state === 'block') {
      if (character === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
      continue;
    }
    // 文字列/テンプレートリテラルの中。エスケープを跨いで閉じ判定を誤らない。
    out += character;
    if (character === '\\') {
      out += next ?? '';
      i += 1;
    } else if (character === state) {
      state = 'code';
    }
  }
  return out;
}

/** 識別子を正規表現へ素で埋め込めるようにエスケープする（`$` が終端アンカーになるのを防ぐ）。 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 *
 * **検出できる範囲は SET_PROPERTY_CALL_PATTERN の形に限られる。** そこに引っかかった
 * 呼び出しのうち上の 2 形に当てはまらないものだけが `unresolved` に積まれ、
 * パターン自体に引っかからない書き方は**そもそも見えない**。具体的には
 * `el.style?.setProperty(…)`、`const { style } = el; style.setProperty(…)`、
 * 第 1 引数に `)` を含む式 (`setProperty(fn(x), …)`)、`cssText` や
 * `setAttribute('style', …)` による一括書き込みは検出されない。
 *
 * その帰結は向きによって違う。向き 1 (書き込まれているのに許可リストに無い) は
 * 単に見逃す。向き 2 (許可リストにあるのに誰も書いていない) は逆に**誤検出で赤くなる** —
 * 実際には書いているのに走査から漏れるためで、黙って緑になるよりは望ましい。
 * 見えない書き方が増えたら、パターンを広げるか呼び出し側を上の 2 形へ寄せること。
 */
function collectSetPropertyTargets(
  filePath: string,
  fileSource: string,
  unresolved: string[],
): Set<string> {
  const targets = new Set<string>();
  // 呼び出しの検出も const 宣言の逆引きも、同じコメント除去済みソースを見る。
  // 片方だけ生ソースにすると、コメントアウトされた宣言で解決できてしまう。
  const source = stripJsComments(fileSource);
  for (const match of source.matchAll(SET_PROPERTY_CALL_PATTERN)) {
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
      `const\\s+${escapeForRegExp(rawArgument)}\\s*(?::[^=]+)?=\\s*(['"])(--[\\w-]+)\\1`,
    );
    const constMatch = source.match(constDeclarationPattern);
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

const VAR_REFERENCE_PATTERN = /var\(\s*(--[\w-]+)/g;

/**
 * bare :root に定義だけあって参照が無いトークンを、意図的に見逃してよいものだけ列挙する
 * (bdboard-kjn9)。
 *
 * `defines every referenced custom property...` (上の向き 1) の逆方向 — 「定義はあるが
 * 参照が無い」— を見る `it` 用の許可リスト。2026-09-06 時点で実測した bare :root の
 * 全トークンはいずれも index.css の CSS か web/src の .ts/.tsx から参照されており、
 * このリストは空。将来ここへ足すのは「意図的に未配線のまま置く」ケースだけにし、
 * 単なる消し忘れを紛れ込ませないこと。
 */
const UNREFERENCED_ROOT_CUSTOM_PROPERTIES = new Set<string>([]);

/**
 * web/src 配下の *.ts / *.tsx を再帰的に列挙する。listRuntimeSourceFiles と違い
 * **テストファイルも test/ ディレクトリも除外しない**。
 *
 * 除外しない理由: この関数は「定義はあるが参照が無い」(向き 2、bdboard-kjn9) の検査専用で、
 * テストコードにしか現れない var() 参照を見逃すと**使われているトークンを未参照と誤判定して
 * 消す**という危険な誤検出になる。実例: `HygienePanel.badge-colors.test.ts` は
 * `var(--badge-stalled-bg)` / `var(--badge-stalled-fg)` を期待値として直接埋め込んでいる。
 * これはランタイム書き込み側 (listRuntimeSourceFiles がテストを除外する理由) とは逆向きの
 * リスクなので、除外の要否も逆になる。
 */
function listAllTsxSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entryName of readdirSync(dir)) {
    const fullPath = join(dir, entryName);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listAllTsxSourceFiles(fullPath));
      continue;
    }
    if (!/\.tsx?$/.test(entryName)) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

/**
 * web/src 配下すべての .ts/.tsx から `var(--foo)` 参照の集合を集める (bdboard-kjn9、
 * 「定義はあるが参照が無い」方向の検査専用)。
 *
 * コメントは stripJsComments で先に取り除く。取り除かないと、たとえば
 * usePopoverViewportClamp.ts の JSDoc 中の
 * `` `transform: translateX(var(--popover-shift-x, 0px))` `` のような**説明目的の言及**を
 * 実参照と誤認し、本当に配線が抜けているケースを見逃す (このテストが赤くなるべき側)。
 *
 * **bdboard-wws5 (未定義参照の検査を .tsx/.ts の var() 参照まで広げる、順方向の拡張) と
 * 走査対象が重なる。** 重複を承知の上で置いている — 本チケットは逆方向の検査なので、
 * wws5 が担当するファイルを先回りして変更しない。将来どちらかが実装されたら、この
 * 走査ロジックを共有ヘルパーへ切り出すことを検討してよい。
 */
function collectTsxCustomPropertyReferences(dir: string): Set<string> {
  const referenced = new Set<string>();
  for (const filePath of listAllTsxSourceFiles(dir)) {
    const source = stripJsComments(readFileSync(filePath, 'utf8'));
    for (const match of source.matchAll(VAR_REFERENCE_PATTERN)) {
      referenced.add(match[1]!);
    }
  }
  return referenced;
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

  it('references every bare :root custom property from index.css or web/src TS(X) (bdboard-kjn9)', () => {
    // 向き 2 (逆方向): 「定義はあるが参照が無い」。上のテストが見る向き 1 の鏡像で、
    // bare :root に定義したまま誰からも参照されなくなったトークン (bdboard-kjn9 の題材)
    // ―― ライト/ダークの対を維持するコストだけが残る死んだ定義 ―― を検出する。
    //
    // CSS の参照だけを見ると TSX 専用トークンが全部死んで見える偽陽性になるため
    // (実例: --color-purple / --throughput-cfd-pinned / --throughput-cfd-hooked は
    // ThroughputStats.tsx からしか参照されない)、CSS の var() と web/src の .ts/.tsx の
    // var() の両方を参照として数える。
    const sourceWithoutComments = stripCssComments(cssSource);
    const definedInBareRoot = collectDefinedCustomProperties(sourceWithoutComments);
    const referencedInCss = collectReferencedCustomProperties(sourceWithoutComments);
    const referencedInTsx = collectTsxCustomPropertyReferences(webSrcDir);
    const referenced = new Set([...referencedInCss, ...referencedInTsx]);

    const unreferencedProperties = [...definedInBareRoot]
      .filter(
        (property) =>
          !referenced.has(property) &&
          !UNREFERENCED_ROOT_CUSTOM_PROPERTIES.has(property),
      )
      .sort();
    // 許可リスト自身の陳腐化も両方向で見る: 参照されるようになった、または bare :root の
    // 定義そのものが消えたエントリは、もう許可リストに残す理由が無い。
    const staleUnreferencedAllowlist = [...UNREFERENCED_ROOT_CUSTOM_PROPERTIES]
      .filter(
        (property) => referenced.has(property) || !definedInBareRoot.has(property),
      )
      .sort();

    expect(
      unreferencedProperties,
      `index.css の bare :root に定義されているのに、index.css からも web/src の .ts/.tsx からも var() 参照が無いカスタムプロパティがあります: ${unreferencedProperties.join(', ')}。使われていないなら定義ごと削除し、ライト/ダークの対を維持するコストだけが残る状態を解消してください。本来ここを使うべき箇所がハードコード値 (#fff 等) になっているだけなら、削除ではなくそこで参照するよう直してください。意図的に未配線のまま置くなら、理由付きで UNREFERENCED_ROOT_CUSTOM_PROPERTIES に追加してください。`,
    ).toEqual([]);
    expect(
      staleUnreferencedAllowlist,
      `UNREFERENCED_ROOT_CUSTOM_PROPERTIES に不要なエントリがあります: ${staleUnreferencedAllowlist.join(', ')}。参照されるようになったか bare :root の定義が無くなったため、許可リストから削除してください。`,
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
    //
    // bare :root に定義がある値は除く。RUNTIME_CUSTOM_PROPERTIES の意味は「実行時に
    // 書かれるので index.css に定義が無くてよい」であって「実行時に書かれる値の一覧」では
    // ない。両者を同一視して *すべての* setProperty 先を許可リストへ強制すると、
    // たとえば --color-accent を実行時に上書きするコンポーネントが 1 つ増えただけで
    // --color-accent が許可リストに載り、**上のテストがその :root 定義の消失を
    // 検出しなくなる** — 免除を塞ぐはずのこのテストが、逆向きの免除窓口を開けてしまう。
    //
    // この除外の代償: bare :root に定義があり、かつ実行時にも書かれる値は、許可リストに
    // 載らないので「向き 2」の書き手削除検出からも外れる。ただし劣化は軽い — 書き手が
    // 消えても :root の既定値に固定されるだけで、var() のフォールバック値に落ちるわけでは
    // ない。そもそも上の staleAllowedProperties が「bare :root に定義された値は許可リスト
    // から外せ」と要求しているので、両立させようとすると解消不能なデッドロックになる。
    const definedInBareRoot = collectDefinedCustomProperties(
      stripCssComments(cssSource),
    );
    const writtenButNotAllowed = [...targets]
      .filter(
        (property) =>
          !RUNTIME_CUSTOM_PROPERTIES.has(property) &&
          !definedInBareRoot.has(property),
      )
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
      `web/src で setProperty されているのに RUNTIME_CUSTOM_PROPERTIES にも bare :root にも無いカスタムプロパティがあります: ${writtenButNotAllowed.join(', ')}。どちらか一方を選んでください — index.css の bare :root に既定値を定義するか、実行時書き込みだけで完結するなら理由付きで RUNTIME_CUSTOM_PROPERTIES に追加する。`,
    ).toEqual([]);
    expect(
      allowedButNotWritten,
      `RUNTIME_CUSTOM_PROPERTIES にあるのに web/src のどこからも setProperty されていないカスタムプロパティがあります: ${allowedButNotWritten.join(', ')}。考えられる原因は 2 つあります: (a) 値を書き込むフックが削除・リネームされた (index.css 側の var() フォールバック値に固定される実害があります)、(b) フックは生きているが書き方が変わり、この走査が見る形 (collectSetPropertyTargets の JSDoc 参照) から外れた — 分割代入やオプショナルチェーン経由の setProperty、cssText / setAttribute('style', …) への置き換えなど。(a) なら setProperty 呼び出しを復元するか、意図的な削除なら RUNTIME_CUSTOM_PROPERTIES からも削除してください。(b) なら走査ロジックを広げるか、呼び出しを検出可能な形へ戻してください。`,
    ).toEqual([]);
  });
});
