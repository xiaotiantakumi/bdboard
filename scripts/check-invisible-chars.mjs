// bdboard-ekvi: PR #908 で正規表現の文字クラスに bidi 制御文字が生のまま入り、GitHub の警告と
// レビュー困難を招いた。Trojan Source に使われる文字や、見えない書式文字の生記述を検出する。
// ESLint の対象外を含むソースを同じ規則で確認し、追加依存や disable コメントによる回避を防ぐ。
// 対象は git の追跡ファイルと未追跡・非 ignore ファイルで、check-invisible-chars/targets.mjs の範囲の表に当たるものに限る
// (ソース、.sh、e2e の stub、.github/ の yml、設定ファイル。範囲と文字・診断の仕様は docs/VERIFY.md「見えない文字の検査」)。
// 削除済みパス (ENOENT / ENOTDIR) だけ読み飛ばし、それ以外で読めないファイルと
// git の一覧取得の失敗は、通ったことにせず検査不能 (exit 2) として失敗する。
// 生の文字そのものは診断に含めず、コードポイント・名前・位置だけを表示する。ファイル名も同じで、
// 制御文字・書式文字・見えない文字は \uXXXX (BMP 外は \u{XXXXX}) のエスケープにして出す (bdboard-rqzv)。
//
// bdboard-rqzv: 範囲 (bin・e2e・設定ファイル・.jsx/.cts) と文字 (U+00AD U+115F U+1160 U+180E U+3164 U+FFA0
// U+2061-2064 U+206A-206F U+E0000-E007F U+2028/2029) を広げた。あわせて、symlink を含むパスから
// 起動しても直接起動と判定する (N5)、UTF-16 (BOM 付き) のファイルをデコードして検査する (N7)、
// repo の外を指す symlink は辿らず警告して読み飛ばす (N7) ようにした。
//
// bdboard-jb5x: 文字 (U+034F U+17B4 U+17B5 U+180B-180D U+180F) と異体字セレクタ (絵文字の直後の U+FE0E / U+FE0F だけ通す)、
// 範囲 (.sh・拡張子の無い e2e の stub・.github/ の yml) を足し、UTF-16 のファイルには「UTF-8 で保存し直す」と案内する。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { charName, escapeForDisplay, findInvisibleChars } from './check-invisible-chars/chars.mjs';
import { fixAdvice } from './check-invisible-chars/advice.mjs';
import { GIT_PATHSPECS, isTargetPath, adviceKind } from './check-invisible-chars/targets.mjs';
import { decodeSource, sourceEncoding } from './check-invisible-chars/source.mjs';

export { charName, decodeSource, escapeForDisplay, findInvisibleChars, isTargetPath, sourceEncoding };
export { adviceKind } from './check-invisible-chars/targets.mjs';

export const EXIT_OK = 0;
export const EXIT_FOUND = 1;
export const EXIT_UNAVAILABLE = 2;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 複数行になりうる外部のエラー文 (git の stderr など) を、改行で診断行を偽造されない 1 行にして出す。
function oneLine(message) {
  return message.trim().split(/\r?\n/).map(escapeForDisplay).join(' / ');
}

// Node は main モジュールの symlink を実体に解決した URL を import.meta.url にするが、process.argv[1] は
// 渡されたパスのまま (macOS の /tmp -> /private/tmp など)。文字列の比較では外れて、何も検査せず exit 0 になる。
// 先に従来の文字列比較を見て、外れたときだけ両方を realpath にして比べる (従来 true だった起動は必ず true のまま。
// Windows のパス表記の揺れで realpath の結果だけがずれても、検査せず exit 0 に退行しない)。
export function isDirectRun(moduleUrl, scriptArg) {
  if (scriptArg === undefined) return false;
  if (moduleUrl === pathToFileURL(scriptArg).href) return true;
  try {
    return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(scriptArg);
  } catch {
    return false;
  }
}

function listGitFiles(repoRoot) {
  const output = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...GIT_PATHSPECS],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // マージ競合中のパスは git ls-files が段 (stage) ごとに 1 行ずつ返すので、同じファイルを何度も報告しないよう重複を除く
  // (git の --deduplicate は旧い git にあるか分からないので JS で除く)。
  return [...new Set(output.split('\0').filter(Boolean))];
}

function isInside(realRoot, realPath) {
  const relative = path.relative(realRoot, realPath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function classifyReadError(error) {
  // 追跡中だが作業ツリーで消したファイル (git ls-files --cached は一覧に残す) や、指す先の無い symlink は読み飛ばす。
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'gone' };
  return { status: 'unreadable', reason: error.code ?? error.message };
}

// 実体のパスを求めて repo の中にあるものだけ読む。repo の外を指す symlink を辿ると、チェックの対象外の
// ファイル (他人のホーム配下など) を読むことになり、その失敗や中身で結果が変わってしまう。
function loadSource(repoRoot, realRoot, relPath) {
  let realPath;
  try {
    realPath = fs.realpathSync(path.join(repoRoot, relPath));
  } catch (error) {
    return classifyReadError(error);
  }
  if (!isInside(realRoot, realPath)) return { status: 'outside' };
  try {
    const buffer = fs.readFileSync(realPath);
    return { status: 'ok', text: decodeSource(buffer), encoding: sourceEncoding(buffer) };
  } catch (error) {
    return classifyReadError(error);
  }
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
    console.error(`invisible-chars: git ls-files に失敗しました (${oneLine(error.message)})`);
    return EXIT_UNAVAILABLE;
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(repoRoot);
  } catch {
    realRoot = repoRoot;
  }

  let inspected = 0;
  let count = 0;
  let unreadable = 0;
  const affected = new Set();
  for (const relPath of files) {
    if (!isTargetPath(relPath)) continue;
    // 診断に出すパスは必ずエスケープする (ファイル名に bidi 制御文字や改行があっても、出力の見え方を変えさせない)。
    const shownPath = escapeForDisplay(relPath);
    const source = loadSource(repoRoot, realRoot, relPath);
    if (source.status === 'gone') continue;
    if (source.status === 'outside') {
      console.error(`invisible-chars: ${shownPath} は repo の外を指す symlink のため辿らず、検査しません (symlink target is outside the repository)`);
      continue;
    }
    if (source.status === 'unreadable') {
      unreadable += 1;
      console.error(`invisible-chars: ${shownPath} を読めませんでした (${escapeForDisplay(String(source.reason))})`);
      continue;
    }
    inspected += 1;
    for (const finding of findInvisibleChars(source.text)) {
      count += 1;
      affected.add(relPath);
      const codePoint = Number.parseInt(finding.codePoint.slice(2), 16);
      // 診断は ASCII だけで書く (生の文字を出力に混ぜない)。直し方は文字コード・ファイルの種類・コードポイントで変わる (advice.mjs)。
      const atFileStart = finding.line === 1 && finding.column === 1;
      const advice = fixAdvice({ encoding: source.encoding, kind: adviceKind(relPath), codePoint, atFileStart });
      console.error(`invisible-chars: ${shownPath}:${finding.line}:${finding.column} ${finding.codePoint} ${charName(codePoint)} - ${advice}`);
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

if (isDirectRun(import.meta.url, process.argv[1])) process.exitCode = main(process.argv.slice(2));
