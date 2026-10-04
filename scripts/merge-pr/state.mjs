// bdboard-ulxa.1: prepare → gate → finish の間で引き継ぐ状態と、監査ログ。
//
// 状態ファイルは git common dir の下 (<common>/bdboard-merge/pr-<n>.json)。worktree ごとの
// .git/worktrees/<name>/ ではなく common dir に置くのは、PR 番号で一意に引けて、worktree を
// 消した後でも finish の残骸を調べられるようにするため。
//
// 監査ログ (枠の占有率の計測用、設計 §4.2) は ${BDBOARD_MERGE_AUDIT_LOG:-$TMPDIR/bdboard-merge-audit.log}
// にタブ区切りで 1 行ずつ。書けなくてもマージ手順は止めない。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { git } from './exec.mjs';

function absoluteGitPath(root, raw) {
  return path.isAbsolute(raw) ? raw : path.resolve(root, raw);
}

export function stateDir(root) {
  return path.join(absoluteGitPath(root, git(['rev-parse', '--git-common-dir'], { cwd: root })), 'bdboard-merge');
}

export function statePath(root, pr) {
  return path.join(stateDir(root), `pr-${pr}.json`);
}

export function readState(root, pr) {
  try {
    return JSON.parse(readFileSync(statePath(root, pr), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(root, pr, state) {
  mkdirSync(stateDir(root), { recursive: true });
  writeFileSync(statePath(root, pr), `${JSON.stringify(state, null, 2)}\n`);
}

export function removeState(root, pr) {
  rmSync(statePath(root, pr), { force: true });
}

/**
 * 残っている状態ファイルを全部読む (読めない・壊れたもの、JSON でもオブジェクトでないもの — null / 数値 /
 * 文字列 / 配列 — は飛ばす)。PR 番号を知らずに、着地コミット (newMain) から finish の記録を引くとき用
 * (bdboard-ulxa.3: merge-pr verify / gate の自己修復がクラス L を見分ける)。
 */
export function listStates(root) {
  const dir = stateDir(root);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const states = [];
  for (const name of names.filter((entry) => /^pr-[0-9]+\.json$/.test(entry))) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        states.push(parsed);
      }
    } catch {
      // 書きかけ・壊れた記録は無いものとして扱う。
    }
  }
  return states;
}

/**
 * この worktree の node_modules がどのコミットの lockfile で入っているか。
 * 着地後検証で npm ci した後にブランチへ戻っても、次の検証が「入っている依存」と
 * 比べられるように、worktree ごと (.git/worktrees/<name>/) に覚える。未記録なら null
 * (= 呼び出し側は HEAD の lockfile で入っているとみなす)。
 */
function installedMarkerPath(root) {
  return path.join(absoluteGitPath(root, git(['rev-parse', '--git-dir'], { cwd: root })), 'bdboard-merge-installed');
}

export function readInstalledFor(root) {
  try {
    const sha = readFileSync(installedMarkerPath(root), 'utf8').trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

export function writeInstalledFor(root, sha) {
  writeFileSync(installedMarkerPath(root), `${sha}\n`);
}

export function auditLogPath() {
  return process.env.BDBOARD_MERGE_AUDIT_LOG || path.join(process.env.TMPDIR || tmpdir(), 'bdboard-merge-audit.log');
}

/** 1 行: ts event pr=.. key=value ... (値の空白・タブは _ に潰す)。追記できたら true、できなければ false (手順は止めない)。 */
export function audit(event, fields) {
  const parts = [new Date().toISOString(), event];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
    }
  }
  try {
    appendFileSync(auditLogPath(), `${parts.join('\t')}\n`);
    return true;
  } catch {
    // 監査ログが書けなくてもマージ手順は止めない。
    return false;
  }
}

/** 標準エラーへの案内行 (stdout は gate が印字するマージコマンド専用に空けておく)。 */
export function say(...lines) {
  for (const line of lines) {
    process.stderr.write(`merge-pr: ${line}\n`);
  }
}
