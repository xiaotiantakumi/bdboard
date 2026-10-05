// bdboard-ekvi: PR #908 で正規表現の文字クラスに bidi 制御文字が生のまま入り、GitHub の警告と
// レビュー困難を招いた。Trojan Source に使われる文字や、見えない書式文字の生記述を検出する。
// ESLint の対象外を含むソースを同じ規則で確認し、追加依存や disable コメントによる回避を防ぐ。
// 対象は git の追跡ファイルと未追跡・非 ignore ファイルで、src / web/src / scripts の
// 指定拡張子に限る。削除済みパス (ENOENT / ENOTDIR) だけ読み飛ばし、それ以外で読めないファイルと
// git の一覧取得の失敗は、通ったことにせず検査不能 (exit 2) として失敗する。
// 生の文字そのものは診断に含めず、コードポイント・名前・位置だけを表示する。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_FOUND = 1;
export const EXIT_UNAVAILABLE = 2;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs']);
const CHAR_NAMES = new Map([
  [0x061c, 'ARABIC LETTER MARK'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x2060, 'WORD JOINER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE (BOM)'],
]);

export function isTargetPath(relPath) {
  const normalized = relPath.replaceAll('\\', '/');
  const inScope = ['src/', 'web/src/', 'scripts/'].some((prefix) => normalized.startsWith(prefix));
  return inScope && EXTENSIONS.has(path.posix.extname(normalized));
}

export function findInvisibleChars(text) {
  const findings = [];
  let line = 1;
  let column = 1;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    if (CHAR_NAMES.has(codePoint)) {
      findings.push({ line, column, codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}` });
    }
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      line += 1;
      column = 1;
    } else if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += char.length;
      if (char.length === 2) index += 1;
    }
  }
  return findings;
}

function listGitFiles(repoRoot) {
  const output = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'web/src', 'scripts'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // マージ競合中のパスは git ls-files が段 (stage) ごとに 1 行ずつ返すので、同じファイルを何度も報告しないよう重複を除く
  // (git の --deduplicate は旧い git にあるか分からないので JS で除く)。
  return [...new Set(output.split('\0').filter(Boolean))];
}

export function main(argv) {
  let repoRoot = REPO_ROOT;
  for (const arg of argv) {
    if (arg.startsWith('--repo=')) repoRoot = path.resolve(arg.slice('--repo='.length));
  }

  let files;
  try {
    files = listGitFiles(repoRoot);
  } catch (error) {
    console.error(`invisible-chars: git ls-files に失敗しました (${error.message.trim()})`);
    return EXIT_UNAVAILABLE;
  }

  let inspected = 0;
  let count = 0;
  let unreadable = 0;
  const affected = new Set();
  for (const relPath of files) {
    if (!isTargetPath(relPath)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    } catch (error) {
      // 追跡中だが作業ツリーで消したファイル (git ls-files --cached は一覧に残す) は読み飛ばす。
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      unreadable += 1;
      console.error(`invisible-chars: ${relPath} を読めませんでした (${error.code ?? error.message})`);
      continue;
    }
    inspected += 1;
    for (const finding of findInvisibleChars(text)) {
      count += 1;
      affected.add(relPath);
      const codePoint = Number.parseInt(finding.codePoint.slice(2), 16);
      // 診断は ASCII だけで書く (生の文字を出力に混ぜない)。JSX のテキスト・属性では \u のエスケープが解釈されないので、その案内も添える。
      console.error(
        `invisible-chars: ${relPath}:${finding.line}:${finding.column} ${finding.codePoint} ${CHAR_NAMES.get(codePoint)} - write it as a \\uXXXX escape, not the raw character (in JSX text or attributes the escape is not interpreted: use a JS expression such as {'\\u200B'})`,
      );
    }
  }

  if (count > 0) {
    console.error(`invisible-chars: ${count} 件を ${affected.size} ファイルで検出しました。`);
    return EXIT_FOUND;
  }
  if (unreadable > 0) {
    console.error(`invisible-chars: ${unreadable} ファイルを読めず、検査できませんでした。`);
    return EXIT_UNAVAILABLE;
  }
  console.log(`invisible-chars: bidi 制御文字・見えない書式文字の生の記述はありません (${inspected} ファイルを検査)。`);
  return EXIT_OK;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = main(process.argv.slice(2));
