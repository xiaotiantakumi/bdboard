import path from 'node:path';
import { WORKTREES_DIR } from '../../domain/git-worktree.js';
import type { RunFailureKind, RunRequest } from '../ports/agent-runner.js';

/**
 * provision 済みの run に対する cwd の二重チェック。
 * `validateRunRequest` が「provision 前の要求」の検証（ticketId/cwd/sessionId の形）
 * であるのに対し、こちらは「provision 後、runner に渡す直前」の境界を守る。
 * provisioner が管理下 worktree 外のパスを返した場合に spawn を止めるため、
 * worktreePath が `<repoRoot>/.claude/worktrees/<ticketId>` の形であることも検証する。
 *
 * `path.resolve` は `..` を正規化するだけで symlink は追わない。realpath 正規化は
 * 呼び出し側が `normalizePath` として注入する依存であり、この関数自体は fs を触らない
 * （application 層を純粋に保つため）。実運用では composition root が infrastructure の
 * `normalizePathForComparison`（realpath + 大文字小文字の正規化）を渡す。これが無いと、
 * provisioner の `findExistingWorktreePath()` が返す `git worktree list --porcelain` の
 * realpath 文字列（macOS の /tmp と /private/tmp など）と、repoRoot から組み立てた
 * expected が食い違い、symlink 越しのプロジェクトでは worktree 再利用のたびに
 * この検証が誤って落ちる。既定の恒等関数は「正規化なし」= 従来挙動。
 *
 * 限界: これは「provisioner が管理下のパスを返したか」の検査であって、symlink 経由の
 * 脱出は検出しない。`<repoRoot>/.claude/worktrees/<ticketId>` 自体が管理外へ張られた
 * symlink なら、両辺とも同じ外部パスへ解決されるので一致してしまう。
 */
export function validateProvisionedRunCwd(
  cwd: string,
  worktreePath: string,
  ticketId: string,
  repoRoot: string,
  normalizePath: (pathValue: string) => string = (pathValue) => pathValue,
): RunFailureKind | null {
  if (ticketId.trim() === '') {
    return 'invalid-request';
  }

  if (worktreePath.trim() === '') {
    return 'invalid-request';
  }

  if (repoRoot.trim() === '') {
    return 'invalid-request';
  }

  const normalizedCwd = normalizePath(path.resolve(cwd));
  const normalizedWorktreePath = normalizePath(path.resolve(worktreePath));
  if (normalizedCwd !== normalizedWorktreePath) {
    return 'invalid-request';
  }

  const expected = path.join(path.resolve(repoRoot), WORKTREES_DIR, ticketId);
  // path.join normalizes ticketId segments like '..' — reject if basename drifts.
  // Checked on the un-normalized join so that a normalizePath fallback (realpath
  // throws for a path that does not exist yet) cannot hide the drift.
  if (path.basename(expected) !== ticketId) {
    return 'invalid-request';
  }

  if (normalizedWorktreePath !== normalizePath(expected)) {
    return 'invalid-request';
  }

  return null;
}

export function validateRunRequest(request: RunRequest): RunFailureKind | null {
  if (request.ticketId.trim() === '') {
    return 'invalid-request';
  }

  if (request.cwd.trim() === '') {
    return 'invalid-request';
  }

  if (
    request.mode === 'resume' &&
    (request.sessionId === undefined || request.sessionId.trim() === '')
  ) {
    return 'invalid-request';
  }

  return null;
}
