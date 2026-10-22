import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BOARD_CHANGED_QUERY_KEY_EXCLUSIONS,
  BOARD_CHANGED_QUERY_KEY_ROOTS,
} from './boardChangedQueryKeys';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

// `queryKey:` の直後 (配列なら先頭要素) のトークンを拾う。
const QUERY_KEY_PATTERN = /queryKey\s*:\s*(\[\s*)?([^\s,\]]+)/g;
const STRING_LITERAL = /^(['"`])([^'"`$\\]+)\1$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// `queryKey` の後ろが `:` でない形 (プロパティ省略形・JSX 属性・分割代入など) は走査できないので失敗させる。
const UNSCANNABLE_QUERY_KEY_PATTERN = /\bqueryKey\b(?!\s*:)/g;

/**
 * 配列先頭が識別子で、root を静的に決められないと分かっている箇所。
 * キーは web/src からの相対パス。ここに無い動的 root はテスト失敗にする。
 */
const DYNAMIC_ROOT_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  // BOARD_CHANGED_QUERY_KEY_ROOTS 自体をループして invalidate する箇所。
  'useBoardStream.ts': ['root'],
};

interface ScanResult {
  readonly roots: string[];
  readonly errors: string[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ブロックコメントと行コメントを落とす (`http://` のような文字列中の `//` は残す)。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function scanQueryKeyRoots(rawSource: string, file: string): ScanResult {
  const source = stripComments(rawSource);
  const roots: string[] = [];
  const errors: string[] = [];
  for (const match of source.matchAll(QUERY_KEY_PATTERN)) {
    const inArray = match[1] !== undefined;
    const token = match[2];
    const literal = STRING_LITERAL.exec(token);
    if (inArray && literal !== null) {
      roots.push(literal[2]);
      continue;
    }
    if (IDENTIFIER.test(token)) {
      if (inArray && (DYNAMIC_ROOT_ALLOWLIST[file] ?? []).includes(token)) continue;
      const id = escapeRegExp(token);
      // 配列先頭の識別子は文字列定数、queryKey 全体の識別子は配列定数として同じファイル内で解決する。
      const definition = new RegExp(
        inArray
          ? `(?:const|let|var)\\s+${id}\\s*=\\s*(['"\`])([^'"\`$\\\\]+)\\1`
          : `(?:const|let|var)\\s+${id}\\s*=\\s*\\[\\s*(['"\`])([^'"\`$\\\\]+)\\1`,
      ).exec(source);
      if (definition !== null) {
        roots.push(definition[2]);
        continue;
      }
    }
    errors.push(
      `${file}: queryKey の root を静的に決められない (${inArray ? '[' : ''}${token})。` +
        'リテラルの root を書くか、同じファイルにリテラルで定義した定数を使うこと' +
        ' (`queryKey: QueryKey` のような型注釈もここに当たるので、別名の型を使うこと)。',
    );
  }
  for (const match of source.matchAll(UNSCANNABLE_QUERY_KEY_PATTERN)) {
    const snippet = source.slice(match.index, match.index + 40).split('\n')[0];
    errors.push(
      `${file}: queryKey が走査できない形で書かれている (${snippet})。` +
        '`queryKey: [...]` の形で書くこと。',
    );
  }
  return { roots, errors };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // web/src/test/ はテスト用ハーネスなので、本番の queryKey には数えない。
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.[^.]+$/.test(entry.name)
      ? [path]
      : [];
  });
}

function scanSourceTree(): ScanResult {
  const roots: string[] = [];
  const errors: string[] = [];
  for (const path of sourceFiles(SOURCE_DIRECTORY)) {
    const file = relative(SOURCE_DIRECTORY, path).split(sep).join('/');
    const result = scanQueryKeyRoots(readFileSync(path, 'utf8'), file);
    roots.push(...result.roots);
    errors.push(...result.errors);
  }
  return { roots, errors };
}

describe('scanQueryKeyRoots', () => {
  it('reads literal roots in any quote style', () => {
    const source = "a({ queryKey: ['a', id] }); b({ queryKey: [\"b\"] }); c({ queryKey: [`c`, x] });";
    expect(scanQueryKeyRoots(source, 'x.ts')).toEqual({ roots: ['a', 'b', 'c'], errors: [] });
  });

  it('resolves same-file array and string constants', () => {
    const source = [
      "const KEY = ['k'] as const;",
      "const ROOT = 'r';",
      'useQuery({ queryKey: KEY });',
      'useQuery({ queryKey: [ROOT, id] });',
    ].join('\n');
    expect(scanQueryKeyRoots(source, 'x.ts')).toEqual({ roots: ['k', 'r'], errors: [] });
  });

  it('fails on roots it cannot resolve statically', () => {
    const source = [
      'useQuery({ queryKey: [someRoot, id] });',
      'useQuery({ queryKey: makeKey(id) });',
      'useQuery({ queryKey: [`x-${kind}`] });',
      'useQuery({ queryKey: [...base, id] });',
    ].join('\n');
    const result = scanQueryKeyRoots(source, 'x.ts');
    expect(result.roots).toEqual([]);
    expect(result.errors).toHaveLength(4);
  });

  it('fails on queryKey forms the scanner cannot read', () => {
    const source = [
      "const queryKey = ['x', id];",
      'useQuery({ queryKey, queryFn });',
      "<Probe queryKey={['y']} />;",
    ].join('\n');
    expect(scanQueryKeyRoots(source, 'x.ts').errors).toHaveLength(3);
  });

  it('ignores queryKey mentions inside comments', () => {
    const source = [
      "// queryKey: ['ghost'] は数えない",
      "/* queryKey: ['ghost2'] */",
      "useQuery({ queryKey: ['real'], queryFn: () => fetchJson('http://x') });",
    ].join('\n');
    expect(scanQueryKeyRoots(source, 'x.ts')).toEqual({ roots: ['real'], errors: [] });
  });

  it('skips an allowlisted dynamic root only in its own file', () => {
    const source = 'invalidateQueries({ queryKey: [root] });';
    expect(scanQueryKeyRoots(source, 'useBoardStream.ts').errors).toEqual([]);
    expect(scanQueryKeyRoots(source, 'other.ts').errors).toHaveLength(1);
  });
});

describe('board.changed queryKey coverage', () => {
  it('classifies every source queryKey root exactly once', () => {
    const { roots, errors } = scanSourceTree();
    const sourceRoots = new Set(roots);
    const invalidatedRoots = new Set<string>(BOARD_CHANGED_QUERY_KEY_ROOTS);
    const exclusions = BOARD_CHANGED_QUERY_KEY_EXCLUSIONS;
    const excludedRoots = new Set(Object.keys(exclusions));

    expect(errors).toEqual([]);
    expect([...invalidatedRoots].filter((root) => excludedRoots.has(root))).toEqual([]);
    expect([...invalidatedRoots].filter((root) => !sourceRoots.has(root))).toEqual([]);
    expect([...excludedRoots].filter((root) => !sourceRoots.has(root))).toEqual([]);
    expect(Object.values(exclusions).every((reason) => reason.trim().length > 0)).toBe(true);
    expect(
      [...sourceRoots].filter((root) => !invalidatedRoots.has(root) && !excludedRoots.has(root)),
    ).toEqual([]);
  });
});
