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
 * 解析不能と分かっているコミットの除外リスト。**エントリは例外**で、増やす前に下の条件を読むこと。
 *
 * 検査範囲は `v<last>..HEAD` なので、解析不能コミットは次のリリースタグを切った時点で
 * 自動的に範囲外になる。つまりこのリストが要るのは「解析不能コミットが main に載って
 * しまい、次のタグを切るまでの間、毎回の main push が赤くなる」という一時的な状況だけ。
 *
 * **エントリの形** (bdboard-721p): 文字列ではなくオブジェクトで、`recovery` が必須。
 * `recovery` を持たないエントリは除外として採用されない (fail-closed)。これは
 * 「CHANGELOG から黙って消える」事象を allowlist 自身が引き起こさないための歯止めで、
 * 除外した分の手当ては毎回の実行で `formatFindings` が全文を再掲する。
 *
 * 旧ルールは「足す前に CHANGELOG へ該当行を手で復元しておくこと」だったが、
 * release-please は always-update: true でリリースPRブランチを main push のたびに
 * 再生成する (bdboard-2tch) ため、先に復元しても次の push で消える = 原理的に満たせない。
 * 実行可能な条件に置き換えたのが上の `recovery` 必須化。
 *
 * 発端の 15651d3 (bdboard-r5we) は v0.1.2 のタグ (f2662b6) が切られて範囲外になったため
 * 削除した。CHANGELOG の行はリリースブランチへ手で足して回復済み (c8a94d4)。
 */
export const KNOWN_UNPARSABLE = [
  {
    // bdboard-ym9r / bdboard-721p。main 上の既存コミットなので履歴書き換え以外に直す手が無く、
    // v0.2.0 のタグを切るまで v0.1.2..HEAD の範囲に残り続けて main push を毎回赤くしていた。
    // 新規発生の防止は PR 側チェック (bdboard-qhsb, ci.yml の pull_request 分岐) が担うので、
    // main push 側でこの 1 件を落とし続ける価値は「タグ前の手当てを忘れないこと」だけ。
    // それは exit 1 ではなく下の recovery の恒久表示で担保する。
    // **削除できるのは v0.2.0 のタグが切られた後** (範囲外になり、下の unused 通知が出る)。
    sha: '5d3be460e19479cfe2fb8e06249bb096a6fcbf7f',
    subject: 'feat(bdboard-h4xs.1): スマホ幅のKanbanにレーン切り替えストリップを追加する (#260)',
    ticket: 'bdboard-ym9r',
    recovery: [
      'リリースPR #258 をマージする直前に、そのブランチの CHANGELOG.md 0.2.0 の Features へ次の 1 行を手で追記する:',
      '  * **bdboard-h4xs.1:** スマホ幅のKanbanにレーン切り替えストリップを追加する ([#260](https://github.com/xiaotiantakumi/bdboard/issues/260)) ([5d3be46](https://github.com/xiaotiantakumi/bdboard/commit/5d3be460e19479cfe2fb8e06249bb096a6fcbf7f))',
      'release-please は always-update: true なので、追記後に main へ push が入ると再生成で消える。',
      '「他の全PRをマージ済み → 追記 → 直後に #258 をマージ」を連続で行うこと。タグを切った後は永久に回復できない。',
    ].join('\n'),
  },
];

const CHANGELOG_TYPES = new Set(['feat', 'fix', 'perf', 'revert', 'deps']);
const CONVENTIONAL_SUBJECT =
  /^(\w+)(\(([^)]*)\))?(!)?: /;

const EXIT_OK = 0;
const EXIT_FOUND = 1;
const EXIT_UNAVAILABLE = 2;

const LOCATION_RE = /\bat (\d+):(\d+)/;

const EXPLICIT_RANGE_FLAGS = new Set(['--range', '--from', '--to']);

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

/**
 * 除外として採用できるエントリか。`sha` と `recovery` の両方が要る (bdboard-721p)。
 *
 * `recovery` を必須にしているのは fail-closed のため。手当ての手順を書かずに黙らせると、
 * このガードが検知しようとしている「CHANGELOG から黙って消える」事象を allowlist 自身が
 * 起こすことになる。書式ミスや古い文字列エントリは「除外しない」側に倒れて赤くなる。
 */
export function isValidAllowlistEntry(entry) {
  if (entry == null || typeof entry !== 'object') {
    return false;
  }
  const { sha, recovery } = entry;
  if (typeof sha !== 'string' || sha.length < MIN_ALLOWLIST_PREFIX_LEN) {
    return false;
  }
  return typeof recovery === 'string' && recovery.trim().length > 0;
}

function matchesSha(entry, sha) {
  return sha.startsWith(entry.sha) || entry.sha.startsWith(sha);
}

function findAllowlistEntry(sha, entries) {
  return entries.find((entry) => matchesSha(entry, sha));
}

/**
 * 解析不能コミットを CHANGELOG 対象 (failures) とそれ以外 (warnings) に分類する。
 */
export function findUnparsableCommits(commits, options = {}) {
  const allowlist = (options.allowlist ?? KNOWN_UNPARSABLE).filter(isValidAllowlistEntry);
  const failures = [];
  const warnings = [];
  const excluded = [];
  const matched = new Set();

  for (const commit of commits) {
    const entry = findAllowlistEntry(commit.sha, allowlist);
    if (entry) {
      matched.add(entry);
      excluded.push({ ...commit, entry });
      continue;
    }

    const parsed = checkCommitMessage(commit.message);
    if (parsed.ok) {
      continue;
    }

    const finding = { ...commit, ...parsed };
    if (isChangelogRelevant(commit.subject)) {
      failures.push(finding);
    } else {
      warnings.push(finding);
    }
  }

  // 範囲内に見つからなかったエントリ。既定範囲での実行なら「タグが切られて範囲外になった =
  // 消してよい」を意味する。PR の限定範囲では当然見つからないので、通知するかは呼び出し側の判断。
  const unused = allowlist.filter((entry) => !matched.has(entry));

  return { failures, warnings, excluded, unused };
}

// bdboard-ekj3: scripts/commit-message-guard.mjs (PreToolUse フック) が同じ体裁で
// 診断を出せるように export する。表示の重複実装を作らないための共有であって、判定側の
// 挙動は変えない。
export function escapeControlChars(text) {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function caretLine(lineText, column) {
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
 * 除外したエントリの手当て (recovery) を毎回再掲する。
 *
 * allowlist は exit code を 0 に戻すだけで、やるべきことは消えていない。タグを切ると
 * その手当ては永久に不可能になるので、赤の代わりにこのブロックが恒久的なリマインダになる。
 */
function formatPendingRecovery(excluded) {
  const entries = [];
  for (const item of excluded) {
    const entry = item?.entry;
    if (entry && !entries.includes(entry)) {
      entries.push(entry);
    }
  }
  if (entries.length === 0) {
    return [];
  }

  const parts = [
    `commit-parse: === リリース (タグ生成) の前にやること ${entries.length} 件 — allowlist で除外した分の手当て ===`,
  ];
  for (const entry of entries) {
    parts.push(`commit-parse:   ${entry.sha.slice(0, 7)} ${entry.subject ?? ''}`.trimEnd());
    if (entry.ticket) {
      parts.push(`commit-parse:     チケット: ${entry.ticket}`);
    }
    for (const line of entry.recovery.split('\n')) {
      parts.push(`commit-parse:     ${line}`);
    }
  }
  return parts;
}

/**
 * 人間 (とエージェント) 向けの本文。exit code は持たせない。
 */
export function formatFindings(result, ctx = {}) {
  const { failures, warnings, excluded } = result;
  const { range, commitCount, reportUnused = false } = ctx;
  const header =
    range != null && commitCount != null
      ? `commit-parse: ${range} の範囲で ${commitCount} 件のコミットを調べました。`
      : `commit-parse: ${commitCount ?? 0} 件のコミットを調べました。`;

  const parts = [header];

  if (failures.length === 0 && warnings.length === 0) {
    parts.push('commit-parse: CHANGELOG 対象の解析不能コミットはありません。');
  }

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
    parts.push(...formatPendingRecovery(excluded));
  }

  // PR の限定範囲 (base..head) では allowlist のエントリが見つからないのが当たり前なので、
  // 既定範囲 (v<last>..HEAD) で走ったときだけ「もう消してよい」を伝える。
  if (reportUnused && result.unused?.length > 0) {
    parts.push(
      `commit-parse: allowlist の ${result.unused.length} 件が範囲内に見つかりません — タグが切られて範囲外になったなら KNOWN_UNPARSABLE から削除してください:`,
    );
    for (const entry of result.unused) {
      parts.push(
        `commit-parse:   ${entry.sha.slice(0, 7)} ${entry.subject ?? ''}${entry.ticket ? ` (${entry.ticket})` : ''}`.trimEnd(),
      );
    }
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

  // 範囲を明示されたとき (PR の base..head) は allowlist の未使用エントリを通知しない。
  // その範囲に居ないのは当たり前で、毎PRに「消してよい」と出すのはノイズにしかならない。
  const isDefaultRange = !rangeArgv.some((arg) => EXPLICIT_RANGE_FLAGS.has(arg));

  const result = findUnparsableCommits(commits);
  console.log(
    formatFindings(result, { range, commitCount: commits.length, reportUnused: isDefaultRange }),
  );

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
