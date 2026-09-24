// scripts/check-commit-parse.mjs から切り出した git 呼び出し (git log の生出力パース・
// git コマンド実行・範囲指定でのコミット読み込み)。bdboard-sso1.63: move-only 分割。
//
// REPO_ROOT: このファイルは元の scripts/check-commit-parse.mjs より1段深い
// scripts/check-commit-parse/ に置かれているため、リポジトリルートまで '..' を1つ多く辿る
// (元は `path.dirname(...)/..`、ここでは `path.dirname(...)/../..`)。指す先(リポジトリ
// ルート)自体は変わらない。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

export function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // 413 件程度の履歴でも 1MB を超えるため、将来の増加に備えて 64MB を確保する (bdboard-ni4r)。
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function loadCommitsInRange(range, repoRoot = REPO_ROOT) {
  const output = git(['log', `--format=%H%x1f%B%x1e`, range], repoRoot);
  return parseCommitsFromGitLog(output);
}
