import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// README の表は網羅性に価値があり、「ここに無い = そんな変数は無い」と読まれる。
// そのため選択肢1を採り、src の実際の読み取りと表の差分を機械的に検出する。

const ENV_HELPERS = [
  'envString',
  'envOptionalString',
  'envBool',
  'envBoolDefaultTrue',
  'envInt',
  'envFloat',
  'envStringList',
] as const;

const ENV_NAME = 'BDBOARD_[A-Z0-9_]+';

function addMatches(names: Set<string>, source: string, pattern: RegExp): void {
  for (const match of source.matchAll(pattern)) {
    names.add(match[1]);
  }
}

/**
 * Whitelist this list when a new environment helper is introduced.  Scanning all
 * BDBOARD_* substrings would incorrectly treat comments, logs, and identifiers
 * (for example BDBOARD_HELP_PROMPT_LINES) as environment reads.
 */
export function extractReadEnvVars(source: string): Set<string> {
  const names = new Set<string>();
  addMatches(names, source, new RegExp(`\\bprocess\\.env\\.(${ENV_NAME})\\b`, 'g'));
  addMatches(
    names,
    source,
    new RegExp(`\\bprocess\\.env\\[\\s*['\"](${ENV_NAME})['\"]\\s*\\]`, 'g'),
  );
  addMatches(names, source, new RegExp(`\\benv\\.(${ENV_NAME})\\b`, 'g'));
  addMatches(
    names,
    source,
    new RegExp(`\\benv\\[\\s*['\"](${ENV_NAME})['\"]\\s*\\]`, 'g'),
  );

  const helperPattern = new RegExp(`\\b(?:${ENV_HELPERS.join('|')})\\s*\\(([^)]*)\\)`, 'g');
  for (const call of source.matchAll(helperPattern)) {
    addMatches(names, call[1], new RegExp(`['\"](${ENV_NAME})['\"]`, 'g'));
  }
  return names;
}

export function collectSourceFiles(sourceDir: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'fixtures') {
          visit(entryPath);
        }
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(entryPath);
      }
    }
  };
  visit(sourceDir);
  return files;
}

export function extractReadmeEnvVars(readme: string): Set<string> {
  const sectionStart = readme.indexOf('## 主要な環境変数');
  if (sectionStart === -1) return new Set();
  const afterHeading = readme.slice(sectionStart + '## 主要な環境変数'.length);
  const nextHeading = afterHeading.search(/\n## /);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  const names = new Set<string>();
  addMatches(names, section, /^\|\s*`(BDBOARD_[A-Z0-9_]+)`\s*\|/gm);
  return names;
}

export function assertEnvDocumentationGuard(
  sourceFiles: readonly string[],
  sourceEnvVars: ReadonlySet<string>,
  readmeEnvVars: ReadonlySet<string>,
): void {
  expect(sourceFiles, 'src/ 配下の非テスト TypeScript ファイルを走査できなかった').not.toHaveLength(0);
  expect(sourceEnvVars, '環境変数を1件も抽出できなかった。抽出ロジックを確認すること').not.toHaveLength(0);
  expect(readmeEnvVars, 'README の環境変数表を抽出できなかった').not.toHaveLength(0);
  // 現在の実装は40件を大きく超える。下限は、主要な抽出パターンが壊れても
  // 「たまたま1件だけ拾って緑」になることを防ぐサニティチェックである。
  expect(sourceEnvVars.size, '環境変数の抽出件数が少なすぎる。抽出ロジックが壊れている可能性がある').toBeGreaterThanOrEqual(40);
  expect(sourceEnvVars.has('BDBOARD_PORT'), 'BDBOARD_PORT を抽出できなかった').toBe(true);
  expect(sourceEnvVars.has('BDBOARD_HOST'), 'BDBOARD_HOST を抽出できなかった').toBe(true);

  const undocumented = [...sourceEnvVars].filter((name) => !readmeEnvVars.has(name)).sort();
  const stale = [...readmeEnvVars].filter((name) => !sourceEnvVars.has(name)).sort();
  expect(undocumented, `src で読まれるが README に無い環境変数: ${undocumented.join(', ')}`).toEqual([]);
  expect(stale, `README にあるが src のどこでも読まれない環境変数: ${stale.join(', ')}`).toEqual([]);
}

describe('README environment-variable documentation', () => {
  it('extracts only real environment reads from supported access forms', () => {
    const source = `
      envString('BDBOARD_MAIN_FORM', 'default');
      envInt(env, 'BDBOARD_REGISTRY_FORM', 1);
      process.env.BDBOARD_PROCESS_DOT;
      process.env['BDBOARD_PROCESS_BRACKET'];
      env.BDBOARD_ENV_DOT;
      env['BDBOARD_ENV_BRACKET'];
      console.log('BDBOARD_LOG_ONLY');
      const BDBOARD_HELP_PROMPT_LINES = [];
    `;
    expect(extractReadEnvVars(source)).toEqual(new Set([
      'BDBOARD_MAIN_FORM',
      'BDBOARD_REGISTRY_FORM',
      'BDBOARD_PROCESS_DOT',
      'BDBOARD_PROCESS_BRACKET',
      'BDBOARD_ENV_DOT',
      'BDBOARD_ENV_BRACKET',
    ]));
  });

  it('rejects empty scan inputs instead of silently passing', () => {
    expect(() => assertEnvDocumentationGuard([], new Set(), new Set())).toThrow();
  });

  it('keeps the README table exactly in sync with real src environment reads', () => {
    const repositoryRoot = process.cwd();
    const sourceFiles = collectSourceFiles(path.join(repositoryRoot, 'src'));
    const sourceEnvVars = new Set<string>();
    for (const file of sourceFiles) {
      for (const name of extractReadEnvVars(fs.readFileSync(file, 'utf8'))) sourceEnvVars.add(name);
    }
    const readmeEnvVars = extractReadmeEnvVars(fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8'));
    assertEnvDocumentationGuard(sourceFiles, sourceEnvVars, readmeEnvVars);
  });
});
