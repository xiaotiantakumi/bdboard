import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `vi.restoreAllMocks()` の直前に `vi.resetAllMocks()` を置く約束を AST で固定する (bdboard-cqur)。
 *
 * ## なぜ要るか
 *
 * Vitest 4 の `vi.restoreAllMocks()` は `vi.spyOn()` で差し替えた spy を元のプロパティへ戻すだけで、
 * `vi.fn()` や spy の呼び出し履歴・実装・once 実装は reset しない (4.1.11 の `@vitest/spy` 実装で確認:
 * restoreAllMocks は spy の restore コールバックを回すだけで、`mockReset()` を全モックに掛けるのは
 * resetAllMocks)。
 * Vitest 3 では restoreAllMocks がそれらも消していたため、PR #445 (bdboard-cd1v) で既存 50 箇所の直前に
 * `vi.resetAllMocks();` を手で置いた。この組は慣習でしか守られておらず、新しいテストが restoreAllMocks
 * だけを書くとテスト間でモック状態が漏れる。
 *
 * ## なぜ設定 (`mockReset` / `restoreMocks`) に寄せないか
 *
 * `mockReset: true` の reset は各テストの直前 (`onBeforeTryTask`、つまり `beforeAll` の後) に走り、
 * モジュールトップの `vi.fn().mockReturnValue(...)` や `beforeAll` で仕込んだ実装を 1 本目のテストから
 * 消す (`vi.fn(impl)` の impl だけは残る。`restoreMocks` 単独は spy を戻すだけで、併用しても同じ)。
 * 現行の全テストはこの形に依存しておらず、設定化しても結果件数が変わらないことは実測した。
 *
 * 公平のために書くと、この検査が強制する afterEach の `vi.resetAllMocks()` も同じものを消す
 * (2 本目のテストから)。違いは範囲で、設定化は全テストファイルへ一律に掛かるのに対し、こちらは
 * restoreAllMocks を自分で書いた (= PR #445 で既に reset を持っている) ファイルだけに留まり、
 * 既存テストの挙動を一切変えない。`clearMocks: true` は呼び出し履歴しか消さず、テスト内で
 * `mockReturnValue` した実装が次のテストへ漏れる本題を防げないので中間案にもならない。
 *
 * ## 規則
 *
 * `vi` / `vitest` から始まる `restoreAllMocks` 呼び出しは、次のどちらかのときだけ組になっている:
 *
 * - 単独の式文で、同じ文リストの直前の文が引数なしの `vi.resetAllMocks()` (`vitest.` も可) の式文
 *   (空行やコメントは文ではないので挟まってよい)
 * - `vi.resetAllMocks().restoreAllMocks()` の連鎖
 *
 * 判定は閉じた世界で行う: ソース中の `restoreAllMocks` という識別子 (と `x['restoreAllMocks']` の
 * 文字列キー) はすべて検査対象で、上の形の呼び出しの名前でなければ違反。したがって reset なし・
 * restore の後に reset・間に別の文・`afterEach(() => vi.restoreAllMocks())` の式本体・
 * `if (x) vi.restoreAllMocks();` のような文リスト外に加え、`afterEach(vi.restoreAllMocks)` の関数渡し・
 * `const { restoreAllMocks } = vi` の分割代入・`vi['restoreAllMocks']()`・`vi` 以外の受け手も違反になる。
 * コメントや文字列中の API 名を数えないため、正規表現ではなく TypeScript parser を使う。
 *
 * 順序は reset → restore に固定する。逆順でも最終状態は同じだが、既存 50 箇所と同じ 1 つの正準形に
 * 揃えておくと違反時の直し方が一意になる (規約としての固定で、挙動上の必然ではない)。
 */

/**
 * リポジトリルートの絶対パス。**このファイルが `src/` 直下に置かれている**ことを前提にした `..` である。
 * 別の深さへ移すなら段数も直すこと (`src/mirrored-files-are-in-sync.test.ts` と同じ前提)。
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 走査するテストコードの置き場 (server / web / 運用スクリプト / e2e 補助の vitest include 全体を覆う)。 */
const SCAN_ROOTS = ['src', 'web/src', 'scripts', 'test'];

/** include の外にあるが全テストに効く setupFiles。グローバルな afterEach の置き場になり得るので走査する。 */
const SCAN_FILES = ['web/vitest.setup.ts'];

/**
 * どの深さでも降下しないディレクトリ名 (依存物・生成物・テスト成果物)。ディレクトリ symlink は
 * `withFileTypes` の dirent 上 `isDirectory()` が false なので辿らない。
 */
const SCAN_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.dolt',
  'logs',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);

const SCAN_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const VITEST_NAMESPACES = new Set(['vi', 'vitest']);

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** `(vi)` / `vi!` の括弧・非 null 表明を剥がす。 */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

/** `vi` / `vitest` 識別子そのもの、または `vi.x().y()` のように根が `vi` / `vitest` の呼び出し連鎖か。 */
function rootsAtVitest(expression: ts.Expression): boolean {
  let current = unwrap(expression);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    current = unwrap(current.expression.expression);
  }
  return ts.isIdentifier(current) && VITEST_NAMESPACES.has(current.text);
}

type RestoreAllMocksCall = ts.CallExpression & { expression: ts.PropertyAccessExpression };

function isRestoreAllMocksCall(node: ts.Node): node is RestoreAllMocksCall {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'restoreAllMocks' &&
    rootsAtVitest(node.expression.expression)
  );
}

function rootsAtVitestIdentifier(expression: ts.Expression): boolean {
  const unwrapped = unwrap(expression);
  return ts.isIdentifier(unwrapped) && VITEST_NAMESPACES.has(unwrapped.text);
}

/** 引数なしの `vi.resetAllMocks()` / `vitest.resetAllMocks()` か。 */
function isBareResetAllMocksCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'resetAllMocks' &&
    rootsAtVitestIdentifier(node.expression.expression)
  );
}

/** 文が属する文リスト。`if (x) stmt;` の本体のように文リストに属さない文は undefined。 */
function enclosingStatementList(statement: ts.Statement): readonly ts.Statement[] | undefined {
  const container = statement.parent;
  if (
    ts.isSourceFile(container) ||
    ts.isBlock(container) ||
    ts.isModuleBlock(container) ||
    ts.isCaseClause(container) ||
    ts.isDefaultClause(container)
  ) {
    return container.statements;
  }
  return undefined;
}

function isPaired(call: RestoreAllMocksCall): boolean {
  if (isBareResetAllMocksCall(unwrap(call.expression.expression))) return true;
  const statement = call.parent;
  if (!ts.isExpressionStatement(statement) || statement.expression !== call) return false;
  const statements = enclosingStatementList(statement);
  if (statements === undefined) return false;
  const previous = statements[statements.indexOf(statement) - 1];
  return previous !== undefined && ts.isExpressionStatement(previous) && isBareResetAllMocksCall(previous.expression);
}

/**
 * `restoreAllMocks` への言及: その名前の識別子 (プロパティ名・分割代入・import 名など位置を問わない) か、
 * `x['restoreAllMocks']` の文字列キー。コメントと、ただの文字列値は含まない。
 */
function isRestoreAllMocksMention(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'restoreAllMocks';
  return (
    ts.isStringLiteralLike(node) &&
    node.text === 'restoreAllMocks' &&
    ts.isElementAccessExpression(node.parent) &&
    node.parent.argumentExpression === node
  );
}

interface RestoreAllMocksSite {
  /** 1 始まりの行番号。 */
  line: number;
  paired: boolean;
}

function analyzeRestoreAllMocks(sourceText: string, fileName: string): RestoreAllMocksSite[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const sites: RestoreAllMocksSite[] = [];
  const visit = (node: ts.Node): void => {
    if (isRestoreAllMocksMention(node)) {
      // 閉じた世界: 言及が「vi.restoreAllMocks(...) 呼び出しの名前」でなければ、それだけで違反。
      const call = node.parent.parent;
      const paired =
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node &&
        isRestoreAllMocksCall(call) &&
        call.expression === node.parent &&
        isPaired(call);
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      sites.push({ line: line + 1, paired });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function findUnpairedRestoreAllMocks(sourceText: string, fileName: string): number[] {
  return analyzeRestoreAllMocks(sourceText, fileName)
    .filter((site) => !site.paired)
    .map((site) => site.line);
}

function toRepoRelativePosix(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function collectCodeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SCAN_EXCLUDED_DIRECTORY_NAMES.has(entry.name)) files.push(...collectCodeFiles(absolutePath));
    } else if (entry.isFile() && SCAN_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe('Vitest mock cleanup pairing (bdboard-cqur)', () => {
  it.each([
    ['paired', 'vi.resetAllMocks();\nvi.restoreAllMocks();', 'fixture.ts', []],
    ['repository afterEach shape', 'afterEach(() => {\n  vi.unstubAllGlobals();\n  vi.resetAllMocks();\n  vi.restoreAllMocks();\n});', 'fixture.ts', []],
    ['blank line and comment between are not statements', 'vi.resetAllMocks();\n\n// note\nvi.restoreAllMocks();', 'fixture.ts', []],
    ['no reset', 'vi.restoreAllMocks();', 'fixture.ts', [1]],
    ['mentions in comments and strings only', '// vi.restoreAllMocks()\nconst note = "vi.restoreAllMocks()";', 'fixture.ts', []],
    ['reset after restore', 'vi.restoreAllMocks();\nvi.resetAllMocks();', 'fixture.ts', [1]],
    ['reset with an argument', 'vi.resetAllMocks(unexpected);\nvi.restoreAllMocks();', 'fixture.ts', [2]],
    ['another statement between', 'vi.resetAllMocks();\ncleanup();\nvi.restoreAllMocks();', 'fixture.ts', [3]],
    ['arrow expression body', 'afterEach(() => vi.restoreAllMocks());', 'fixture.ts', [1]],
    ['statement outside a statement list', 'vi.resetAllMocks();\nif (flag) vi.restoreAllMocks();', 'fixture.ts', [2]],
    ['paired inside an if block', 'if (flag) {\n  vi.resetAllMocks();\n  vi.restoreAllMocks();\n}', 'fixture.ts', []],
    ['chained after reset', 'vi.resetAllMocks().restoreAllMocks();', 'fixture.ts', []],
    ['chained after something else', 'vi.useRealTimers().restoreAllMocks();', 'fixture.ts', [1]],
    ['vitest namespace in TSX', 'const view = <div />;\nvitest.resetAllMocks();\nvitest.restoreAllMocks();', 'fixture.tsx', []],
    ['CRLF line numbers', 'vi.resetAllMocks();\r\nvi.restoreAllMocks();\r\nvi.restoreAllMocks();', 'fixture.ts', [3]],
    ['only the second of two sites is unpaired', 'vi.resetAllMocks();\nvi.restoreAllMocks();\nvi.restoreAllMocks();', 'fixture.ts', [3]],
    ['JavaScript module', 'vi.restoreAllMocks();', 'fixture.mjs', [1]],
    ['parenthesized / non-null receiver paired', 'vi.resetAllMocks();\n(vi)!.restoreAllMocks();', 'fixture.ts', []],
    ['passed as a function', 'vi.resetAllMocks();\nafterEach(vi.restoreAllMocks);', 'fixture.ts', [2]],
    ['destructured', 'const { restoreAllMocks } = vi;\nrestoreAllMocks();', 'fixture.ts', [1, 2]],
    ['element access', "vi.resetAllMocks();\nvi['restoreAllMocks']();", 'fixture.ts', [2]],
    ['aliased import receiver', "import { vi as v } from 'vitest';\nv.resetAllMocks();\nv.restoreAllMocks();", 'fixture.ts', [3]],
    ['non-vitest receiver', 'helper.restoreAllMocks();', 'fixture.ts', [1]],
    ['JSX module', 'const view = <div />;\nvi.restoreAllMocks();', 'fixture.jsx', [2]],
  ])('%s', (_name, sourceText, fileName, expected) => {
    expect(findUnpairedRestoreAllMocks(sourceText, fileName)).toEqual(expected);
  });

  // 400 ファイル規模の readdir + read が並列 verify の負荷で延びても落ちないよう 15s。parse は
  // `restoreAllMocks` を含むファイルだけに絞る (呼び出しは必ずこの識別子を字面に含むので取りこぼさない)。
  it('keeps every repository restoreAllMocks call immediately paired with resetAllMocks', () => {
    const sites: string[] = [];
    const violations: string[] = [];
    const files = [
      ...SCAN_ROOTS.flatMap((root) => collectCodeFiles(path.join(REPO_ROOT, root))),
      // 存在しなければ readFileSync が ENOENT で落ちる = 設定から外れたのに走査が黙って縮むことはない。
      ...SCAN_FILES.map((file) => path.join(REPO_ROOT, file)),
    ];
    for (const absolutePath of files) {
      const sourceText = readFileSync(absolutePath, 'utf8');
      if (!sourceText.includes('restoreAllMocks')) continue;
      const relativePath = toRepoRelativePosix(absolutePath);
      for (const site of analyzeRestoreAllMocks(sourceText, relativePath)) {
        const location = `${relativePath}:${site.line}`;
        sites.push(location);
        if (!site.paired) violations.push(location);
      }
    }

    // 走査が空振りして素通しするのを防ぐ下限。restoreAllMocks の利用が正当に減ったら下げてよい。
    expect(sites.length).toBeGreaterThanOrEqual(40);
    expect(sites.some((site) => site.startsWith('src/'))).toBe(true);
    expect(sites.some((site) => site.startsWith('web/src/'))).toBe(true);
    expect(
      violations,
      'vi.restoreAllMocks(); は単独の文で書き、その直前の文に vi.resetAllMocks(); を置くこと。Vitest 4 の ' +
        'restoreAllMocks は vi.spyOn の spy を戻すだけで、vi.fn() や spy の呼び出し履歴・実装は reset しない ' +
        '(bdboard-cd1v / PR #445)。追加した reset はモジュールトップや beforeAll で仕込んだ実装も次のテスト' +
        'から消すので、それらは beforeEach で仕込み直すこと。',
    ).toEqual([]);
  }, 15_000);
});
