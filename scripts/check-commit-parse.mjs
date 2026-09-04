// bdboard-84hu: release-please が @conventional-commits/parser で解析できないコミットを
// 黙って CHANGELOG から落とす。ジョブ自体は success のままなので、タグを切る前に
// v<last>..HEAD の範囲を機械的に検査する。
//
// 背景 (PR #248 / 15651d3): 本文で `(` を開いて次の行で `)` を閉じると PEG パーサが改行で
// 落ち、release-please は "commit could not be parsed" を 1 行出すだけで続行する。
// タグ以降のコミットから CHANGELOG を計算するため、取りこぼしたままタグを切るとその
// コミットは以後どのリリースにも二度と現れない。
//
// exit code: 0 = 問題なし / 1 = CHANGELOG 対象の解析不能コミットあり / 2 = チェック不能
// (check-drift.mjs と同様、2 は「調べられなかった」。1 はこちらだけ検知で落とす)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parser } from '@conventional-commits/parser';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 解析不能と分かっているコミットの除外リスト。**既定は空にしておく。**
 *
 * 検査範囲は `v<last>..HEAD` なので、解析不能コミットは次のリリースタグを切った時点で
 * 自動的に範囲外になる。つまりこのリストが要るのは「解析不能コミットが main に載って
 * しまい、次のタグを切るまでの間、毎回の main push が赤くなる」という一時的な状況だけ。
 *
 * 発端の 15651d3 (bdboard-r5we) は v0.1.2 のタグ (f2662b6) が切られて範囲外になったため
 * 削除した。CHANGELOG の行はリリースブランチへ手で足して回復済み (c8a94d4)。
 *
 * **エントリを足すときの条件**: 先に CHANGELOG へ該当行を手で復元すること。復元せずに
 * 除外だけすると、このガードが検知しようとしている「CHANGELOG から黙って消える」事象を
 * 自分で起こすことになる。足す場合は理由と、いつ消せるようになるかをコメントで残す。
 */
export const KNOWN_UNPARSABLE = [];

const CHANGELOG_TYPES = new Set(['feat', 'fix', 'perf', 'revert', 'deps']);
const CONVENTIONAL_SUBJECT =
  /^(\w+)(\(([^)]*)\))?(!)?: /;

const EXIT_OK = 0;
const EXIT_FOUND = 1;
const EXIT_UNAVAILABLE = 2;

const LOCATION_RE = /\bat (\d+):(\d+)/;

/**
 * release-please と同じ parser で 1 件のコミット本文を検査する。純関数。
 */
export function checkCommitMessage(message) {
  try {
    parser(message);
    return { ok: true };
  } catch (error) {
    const parserMessage = error instanceof Error ? error.message : String(error);
    const match = LOCATION_RE.exec(parserMessage);
    const line = match ? Number.parseInt(match[1], 10) : null;
    const column = match ? Number.parseInt(match[2], 10) : null;
    return { ok: false, line, column, parserMessage };
  }
}

/**
 * 件名 1 行目が CHANGELOG に載る conventional コミットか。
 */
export function isChangelogRelevant(subject) {
  const match = CONVENTIONAL_SUBJECT.exec(subject);
  if (!match) {
    return false;
  }
  if (match[4] === '!') {
    return true;
  }
  return CHANGELOG_TYPES.has(match[1]);
}

const MIN_ALLOWLIST_PREFIX_LEN = 7;

function isValidAllowlistEntry(entry) {
  return typeof entry === 'string' && entry.length >= MIN_ALLOWLIST_PREFIX_LEN;
}

function isAllowlisted(sha, allowlist) {
  return allowlist
    .filter(isValidAllowlistEntry)
    .some((entry) => sha.startsWith(entry) || entry.startsWith(sha));
}

/**
 * 解析不能コミットを CHANGELOG 対象 (failures) とそれ以外 (warnings) に分類する。
 */
export function findUnparsableCommits(commits, options = {}) {
  const allowlist = options.allowlist ?? KNOWN_UNPARSABLE;
  const failures = [];
  const warnings = [];
  const excluded = [];

  for (const commit of commits) {
    if (isAllowlisted(commit.sha, allowlist)) {
      excluded.push(commit);
      continue;
    }

    const parsed = checkCommitMessage(commit.message);
    if (parsed.ok) {
      continue;
    }

    const entry = { ...commit, ...parsed };
    if (isChangelogRelevant(commit.subject)) {
      failures.push(entry);
    } else {
      warnings.push(entry);
    }
  }

  return { failures, warnings, excluded };
}

function escapeControlChars(text) {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function caretLine(lineText, column) {
  if (column == null || column < 1) {
    return '';
  }
  if (column > lineText.length) {
    return 'この行の末尾 (改行) で落ちています。開いた括弧が次の行に持ち越されています。';
  }
  return `${' '.repeat(column - 1)}^`;
}

function formatFailure(failure) {
  const shortSha = failure.sha.slice(0, 7);
  const location =
    failure.line != null && failure.column != null
      ? `${failure.line}:${failure.column}`
      : '(位置不明)';
  const lines = failure.message.split('\n');
  const lineText =
    failure.line != null && failure.line >= 1 && failure.line <= lines.length
      ? lines[failure.line - 1]
      : '';
  const caret = caretLine(lineText, failure.column);
  const parserMessage = escapeControlChars(failure.parserMessage);

  return [
    `commit-parse: ${shortSha} ${failure.subject}`,
    `commit-parse:   パーサ: ${location} — ${parserMessage}`,
    lineText ? `commit-parse:   ${lineText}` : '',
    caret ? `commit-parse:   ${caret}` : '',
    'commit-parse:   直し方: 本文で開いた `(` は同じ行の中で閉じる。行をまたぐと release-please が CHANGELOG からこのコミットを丸ごと落とす。',
    'commit-parse:   取りこぼしたままタグを切ると CHANGELOG から永久に消える — タグ前に直すか手で追記すること。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 人間 (とエージェント) 向けの本文。exit code は持たせない。
 */
export function formatFindings(result, ctx = {}) {
  const { failures, warnings, excluded } = result;
  const { range, commitCount } = ctx;
  const header =
    range != null && commitCount != null
      ? `commit-parse: ${range} の範囲で ${commitCount} 件のコミットを調べました。`
      : `commit-parse: ${commitCount ?? 0} 件のコミットを調べました。`;

  if (failures.length === 0 && warnings.length === 0) {
    const parts = [`${header}\ncommit-parse: CHANGELOG 対象の解析不能コミットはありません。`];
    if (excluded?.length > 0) {
      parts.push(
        `commit-parse: allowlist により ${excluded.length} 件を除外しました (既知の取りこぼし)。`,
      );
    }
    return parts.join('\n');
  }

  const parts = [header];

  if (failures.length > 0) {
    parts.push(
      `commit-parse: CHANGELOG から落ちる解析不能コミットが ${failures.length} 件あります:`,
    );
    for (const failure of failures) {
      parts.push(formatFailure(failure));
    }
  }

  if (warnings.length > 0) {
    parts.push(`commit-parse: 参考 — CHANGELOG 対象外の解析不能コミット ${warnings.length} 件:`);
    for (const warning of warnings) {
      parts.push(
        `commit-parse:   ${warning.sha.slice(0, 7)} ${warning.subject} (${warning.parserMessage})`,
      );
    }
  }

  if (excluded?.length > 0) {
    parts.push(
      `commit-parse: allowlist により ${excluded.length} 件を除外しました (既知の取りこぼし)。`,
    );
  }

  return parts.join('\n');
}

export function parseCommitsFromGitLog(output) {
  const records = output
    .split('\x1e')
    .map((record) => record.replace(/^\r?\n+/, ''))
    .filter((record) => record.length > 0);
  return records.map((record) => {
    const sep = record.indexOf('\x1f');
    if (sep === -1) {
      throw new Error('commit-parse: git log 出力の区切りが壊れています');
    }
    const sha = record.slice(0, sep);
    const message = record.slice(sep + 1).replace(/\n$/, '');
    const subject = message.split('\n')[0] ?? '';
    return { sha, subject, message };
  });
}

export function readLastReleaseVersion(repoRoot = REPO_ROOT) {
  const manifestPath = path.join(repoRoot, '.release-please-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest['.'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('commit-parse: .release-please-manifest.json の "." バージョンが無効です');
  }
  return version;
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function parseCliArgs(argv) {
  let repoRoot = REPO_ROOT;
  const rangeArgv = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') {
      repoRoot = path.resolve(argv[++i]);
    } else {
      rangeArgv.push(arg);
    }
  }

  return { repoRoot, rangeArgv };
}

export function resolveRange(argv, repoRoot = REPO_ROOT) {
  let fromRef;
  let toRef;
  let explicitRange;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') {
      fromRef = argv[++i];
    } else if (arg === '--to') {
      toRef = argv[++i];
    } else if (arg === '--range') {
      explicitRange = argv[++i];
    } else if (arg === '--repo') {
      i += 1;
    }
  }

  if (explicitRange) {
    return explicitRange;
  }
  if (fromRef && toRef) {
    return `${fromRef}..${toRef}`;
  }
  if (fromRef || toRef) {
    throw new Error('commit-parse: --from と --to は両方指定してください');
  }

  const version = readLastReleaseVersion(repoRoot);
  const tag = `v${version}`;
  git(['rev-parse', '-q', '--verify', `${tag}^{commit}`], repoRoot);
  return `${tag}..HEAD`;
}

export function loadCommitsInRange(range, repoRoot = REPO_ROOT) {
  const output = git(['log', `--format=%H%x1f%B%x1e`, range], repoRoot);
  return parseCommitsFromGitLog(output);
}

function main(argv) {
  const { repoRoot, rangeArgv } = parseCliArgs(argv);

  let range;
  try {
    range = resolveRange(rangeArgv, repoRoot);
  } catch (error) {
    console.error(`commit-parse: ${error.message.trim()}`);
    return EXIT_UNAVAILABLE;
  }

  let commits;
  try {
    commits = loadCommitsInRange(range, repoRoot);
  } catch (error) {
    console.error(`commit-parse: git log に失敗しました (${error.message.trim()})`);
    return EXIT_UNAVAILABLE;
  }

  const result = findUnparsableCommits(commits);
  console.log(formatFindings(result, { range, commitCount: commits.length }));

  if (result.failures.length > 0) {
    return EXIT_FOUND;
  }
  return EXIT_OK;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
