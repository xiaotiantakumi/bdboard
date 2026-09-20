// bdboard-jygp: 1ファイルに無関係な変更理由が同居している状態を機械的に検出するガード。
//
// 行数そのものが目的ではない。目安を超える行数は「このファイルが複数の関心事を抱えている」
// ことの代理指標であり、超えたら「分割する」か「理由を書いて baseline に登録する」の
// どちらかを強制することで、巨大ファイルが無言で肥大化し続けるのを止める (詳細:
// docs/VERIFY.md の「ファイルサイズガード」節)。
//
// 対象はファイルシステム走査ではなく `git ls-files --cached --others --exclude-standard`
// (未追跡だがまだ commit していない新規ファイルも拾う。node_modules / dist 等は
// .gitignore 経由で自然に除外される)。行数の既定上限・baseline (登録済みファイルの
// 個別上限と理由) は両方とも scripts/file-size-baseline.json に置き、このスクリプトには
// 数値を埋め込まない (並行 PR で baseline だけを更新できるようにするため)。
//
// 判定 (詳しい理由は docs/VERIFY.md):
//   (a) baseline に無いファイルが既定上限超               → fail
//   (b) baseline のファイルが自分の limit 超               → fail
//   (c) baseline にあるのに既定上限以下 / ファイルが無い   → fail (baseline から外す)
//   (d) baseline の limit が現行行数より 200 行以上大きい  → warn (ラチェットを締める余地)
//
// exit code: 0 = 問題なし / 1 = (a)(b)(c) のいずれかを検知 / 2 = 検査そのものが実行不能
// (git 呼び出し失敗・baseline JSON の形式不正など)。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_RELATIVE_PATH = 'scripts/file-size-baseline.json';

// 対象ディレクトリ・拡張子・除外規則 (fixtures 配下と生成物)。パスは常に git ls-files が
// 返す POSIX 区切りの相対パスとして扱う — Windows でも git は '/' 区切りで返すため、
// このスクリプトは path.sep を一度も使わない (verify-windows 対策)。
export const TARGET_DIRS = ['src', 'web/src', 'scripts', 'harness', 'test'];
export const TARGET_EXTENSIONS = ['.tsx', '.ts', '.mjs', '.js', '.css', '.sh'];
const TEST_PATTERN = /\.(test|spec)\.[^./]+$/;
const FIXTURE_PATTERN = /(^|\/)fixtures(\/|$)/;

export const EXIT_OK = 0;
export const EXIT_FOUND = 1;
export const EXIT_UNAVAILABLE = 2;

/** 対象ディレクトリ配下 かつ 対象拡張子 か (fixtures 判定はここに含めない)。 */
export function isTargetPath(relPath) {
  const inTargetDir = TARGET_DIRS.some(
    (dir) => relPath === dir || relPath.startsWith(`${dir}/`),
  );
  if (!inTargetDir) {
    return false;
  }
  return TARGET_EXTENSIONS.some((ext) => relPath.endsWith(ext));
}

export function isTestPath(relPath) {
  return TEST_PATTERN.test(relPath.slice(relPath.lastIndexOf('/') + 1));
}

export function isFixturePath(relPath) {
  return FIXTURE_PATTERN.test(relPath);
}

/**
 * CRLF でも LF でも同じ値になる行数カウント。純関数。
 *
 * 空ファイルは 0 行。末尾に改行がある通常のテキストファイルは、その末尾の空要素を
 * 数えない (== `wc -l` と同じ挙動)。末尾に改行が無いファイルは最終行も 1 行として数える。
 */
export function countLines(text) {
  if (text.length === 0) {
    return 0;
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.length;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

/**
 * git 管理下 (index) + 未追跡だが無視されていないファイル。対象ディレクトリだけに絞って
 * 渡すことで、無関係な巨大ディレクトリの走査コストを避ける。
 */
export function listGitFiles(repoRoot) {
  const output = git(
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...TARGET_DIRS],
    repoRoot,
  );
  return output.length === 0 ? [] : output.split('\n');
}

/**
 * 対象パスを実ファイルとして読み、行数を添えたレコードにする。fixtures 配下は除外。
 * git には載っているが作業ツリーから消えている (未 `git rm` の削除) パスは、読めない
 * ものとして黙って除く — baseline に登録されていれば missing 側で拾われる。
 */
export function buildFileRecords(repoRoot, gitFiles) {
  const records = [];
  for (const relPath of gitFiles) {
    if (!isTargetPath(relPath) || isFixturePath(relPath)) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    } catch {
      continue;
    }
    records.push({ path: relPath, isTest: isTestPath(relPath), lines: countLines(text) });
  }
  return records;
}

// ---- baseline 設定の読み込みと検証 (fail-closed: 形式不正は「無視」ではなく実行不能) ----

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

/** baseline エントリ1件の形式検証。壊れていれば理由の配列を返す (空 = 妥当)。 */
export function validateEntryShape(entry, index) {
  const errors = [];
  const where = `entries[${index}]`;
  if (!isPlainObject(entry)) {
    return [`${where} はオブジェクトである必要があります`];
  }
  const { path: entryPath, limit, reason } = entry;
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    errors.push(`${where}.path は空でない文字列にしてください`);
  } else if (entryPath.includes('\\')) {
    errors.push(`${where}.path (${entryPath}) はバックスラッシュを含めず POSIX 区切りで書いてください`);
  } else if (entryPath !== path.posix.normalize(entryPath) || entryPath.startsWith('/')) {
    errors.push(`${where}.path (${entryPath}) は正規化された相対パスにしてください`);
  }
  if (!isPositiveInt(limit)) {
    errors.push(`${where}.limit (${String(limit)}) は正の整数にしてください`);
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    errors.push(`${where}.reason は空にできません (中身を見て書いた実態の説明が要る)`);
  }
  return errors;
}

/**
 * baseline JSON テキストを検証・構造化する。エントリの重複パスも fail-closed 対象。
 * 返り値の entries は Map<posix path, {limit, reason}>。
 */
export function parseBaselineConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`baseline JSON の構文が壊れています (${error.message})`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('baseline JSON はトップレベルがオブジェクトである必要があります');
  }
  const errors = [];
  const { defaultLimits, ratchetWarningThreshold, entries } = parsed;
  if (!isPlainObject(defaultLimits) || !isPositiveInt(defaultLimits.nonTest) || !isPositiveInt(defaultLimits.test)) {
    errors.push('defaultLimits.nonTest / defaultLimits.test は正の整数にしてください');
  }
  if (!isPositiveInt(ratchetWarningThreshold)) {
    errors.push('ratchetWarningThreshold は正の整数にしてください');
  }
  if (!Array.isArray(entries)) {
    errors.push('entries は配列である必要があります');
  }

  const entryMap = new Map();
  if (Array.isArray(entries)) {
    entries.forEach((entry, index) => {
      const entryErrors = validateEntryShape(entry, index);
      if (entryErrors.length > 0) {
        errors.push(...entryErrors);
        return;
      }
      if (entryMap.has(entry.path)) {
        errors.push(`entries に ${entry.path} が重複しています`);
        return;
      }
      entryMap.set(entry.path, { limit: entry.limit, reason: entry.reason });
    });
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  return {
    defaultLimits: { nonTest: defaultLimits.nonTest, test: defaultLimits.test },
    ratchetWarningThreshold,
    entries: entryMap,
  };
}

// ---- 判定本体 ----

/**
 * 走査結果 (records) と baseline を突き合わせ、(a)〜(d) に分類する。純関数。
 */
export function evaluate(records, config) {
  const { defaultLimits, ratchetWarningThreshold, entries } = config;
  const newOverLimit = [];
  const overOwnLimit = [];
  const shrunkBelowDefault = [];
  const ratchetWarnings = [];
  const ok = [];
  const seen = new Set();

  for (const record of records) {
    const defaultLimit = record.isTest ? defaultLimits.test : defaultLimits.nonTest;
    const baseline = entries.get(record.path);

    if (!baseline) {
      if (record.lines > defaultLimit) {
        newOverLimit.push({ path: record.path, lines: record.lines, defaultLimit });
      } else {
        ok.push({ ...record, defaultLimit, baseline: null });
      }
      continue;
    }

    seen.add(record.path);
    if (record.lines > baseline.limit) {
      overOwnLimit.push({ path: record.path, lines: record.lines, limit: baseline.limit });
    } else if (record.lines <= defaultLimit) {
      shrunkBelowDefault.push({
        path: record.path,
        lines: record.lines,
        limit: baseline.limit,
        defaultLimit,
      });
    } else {
      ok.push({ ...record, defaultLimit, baseline });
      const gap = baseline.limit - record.lines;
      if (gap >= ratchetWarningThreshold) {
        ratchetWarnings.push({ path: record.path, lines: record.lines, limit: baseline.limit, gap });
      }
    }
  }

  // baseline にあるのに今回の走査結果に一度も現れなかった = 削除 / リネーム / 対象外化。
  const missingFiles = [];
  for (const [entryPath, entry] of entries) {
    if (!seen.has(entryPath)) {
      missingFiles.push({ path: entryPath, limit: entry.limit });
    }
  }

  return { newOverLimit, overOwnLimit, shrunkBelowDefault, missingFiles, ratchetWarnings, ok };
}

// ---- 表示 ----

function formatFinding(prefix, lines) {
  return lines.map((line) => `file-size:   ${line}`).join('\n');
}

export function formatResult(evaluation, { report = false } = {}) {
  const { newOverLimit, overOwnLimit, shrunkBelowDefault, missingFiles, ratchetWarnings, ok } =
    evaluation;
  const parts = [];
  const total =
    newOverLimit.length + overOwnLimit.length + shrunkBelowDefault.length + missingFiles.length;

  if (total === 0) {
    parts.push('file-size: 巨大ファイルの新規発生・baseline 超過はありません。');
  } else {
    parts.push(`file-size: 対処が要る項目が ${total} 件あります。`);
  }

  if (newOverLimit.length > 0) {
    parts.push(
      `file-size: (a) baseline 未登録で既定上限を超えている新規/未追跡ファイル ${newOverLimit.length} 件:`,
    );
    parts.push(
      formatFinding(
        'a',
        newOverLimit.map(
          (f) =>
            `${f.path} (${f.lines} 行 > 既定上限 ${f.defaultLimit} 行) — 分割するか、理由を添えて ${CONFIG_RELATIVE_PATH} に登録してください`,
        ),
      ),
    );
  }

  if (overOwnLimit.length > 0) {
    parts.push(`file-size: (b) baseline の limit を超えているファイル ${overOwnLimit.length} 件:`);
    parts.push(
      formatFinding(
        'b',
        overOwnLimit.map(
          (f) =>
            `${f.path} (${f.lines} 行 > baseline limit ${f.limit} 行) — 分割するか、${CONFIG_RELATIVE_PATH} の limit と reason を書き換えてください`,
        ),
      ),
    );
  }

  if (shrunkBelowDefault.length > 0) {
    parts.push(
      `file-size: (c) baseline にあるが既定上限以下まで縮んだファイル ${shrunkBelowDefault.length} 件:`,
    );
    parts.push(
      formatFinding(
        'c',
        shrunkBelowDefault.map(
          (f) =>
            `${f.path} (${f.lines} 行 <= 既定上限 ${f.defaultLimit} 行、baseline limit ${f.limit} 行) — ${CONFIG_RELATIVE_PATH} の entries から外してください`,
        ),
      ),
    );
  }

  if (missingFiles.length > 0) {
    parts.push(
      `file-size: (c) baseline にあるが対象ファイルが見つからないもの ${missingFiles.length} 件 (削除 / リネーム / 対象ディレクトリ外への移動):`,
    );
    parts.push(
      formatFinding(
        'c',
        missingFiles.map(
          (f) => `${f.path} (baseline limit ${f.limit} 行) — ${CONFIG_RELATIVE_PATH} の entries から外してください`,
        ),
      ),
    );
  }

  if (ratchetWarnings.length > 0) {
    parts.push(
      `file-size: (d) 警告 — baseline の limit が現行行数より 200 行以上大きく、ラチェットを締める余地があります (${ratchetWarnings.length} 件):`,
    );
    parts.push(
      formatFinding(
        'd',
        ratchetWarnings.map(
          (f) => `${f.path} (現行 ${f.lines} 行、limit ${f.limit} 行、差 ${f.gap} 行)`,
        ),
      ),
    );
  }

  if (report) {
    const rows = [
      ...ok.map((r) => ({ path: r.path, lines: r.lines, limit: r.baseline?.limit ?? r.defaultLimit, hasBaseline: r.baseline != null })),
      ...newOverLimit.map((f) => ({ path: f.path, lines: f.lines, limit: f.defaultLimit, hasBaseline: false })),
      ...overOwnLimit.map((f) => ({ path: f.path, lines: f.lines, limit: f.limit, hasBaseline: true })),
      ...shrunkBelowDefault.map((f) => ({ path: f.path, lines: f.lines, limit: f.limit, hasBaseline: true })),
    ].sort((x, y) => y.lines - x.lines);
    parts.push(`file-size: --report 一覧 (行数降順、${rows.length} 件):`);
    parts.push(
      rows
        .map((r) => `file-size:   ${r.lines}\t${r.hasBaseline ? `baseline limit=${r.limit}` : '(baseline無し)'}\t${r.path}`)
        .join('\n'),
    );
  }

  return parts.join('\n');
}

// ---- CLI ----

function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, CONFIG_RELATIVE_PATH);
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`${CONFIG_RELATIVE_PATH} を読めません (${error.message})`);
  }
  return parseBaselineConfig(text);
}

export function parseCliArgs(argv) {
  let repoRoot = REPO_ROOT;
  let report = false;
  for (const arg of argv) {
    if (arg === '--report') {
      report = true;
    } else if (arg.startsWith('--repo=')) {
      repoRoot = path.resolve(arg.slice('--repo='.length));
    }
  }
  return { repoRoot, report };
}

function main(argv) {
  const { repoRoot, report } = parseCliArgs(argv);

  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (error) {
    console.error(`file-size: baseline 設定を読み込めません。\n${error.message}`);
    return EXIT_UNAVAILABLE;
  }

  let gitFiles;
  try {
    gitFiles = listGitFiles(repoRoot);
  } catch (error) {
    console.error(`file-size: git ls-files に失敗しました (${error.message.trim()})`);
    return EXIT_UNAVAILABLE;
  }

  const records = buildFileRecords(repoRoot, gitFiles);
  const evaluation = evaluate(records, config);
  console.log(formatResult(evaluation, { report }));

  const failing =
    evaluation.newOverLimit.length +
    evaluation.overOwnLimit.length +
    evaluation.shrunkBelowDefault.length +
    evaluation.missingFiles.length;
  return failing > 0 ? EXIT_FOUND : EXIT_OK;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
