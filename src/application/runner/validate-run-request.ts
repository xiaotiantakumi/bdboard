import path from 'node:path';
import type { RunFailureKind, RunRequest } from '../ports/agent-runner.js';

/**
 * provision 済みの run に対する cwd の二重チェック。
 * `validateRunRequest` が「provision 前の要求」の検証（ticketId/cwd/sessionId の形）
 * であるのに対し、こちらは「provision 後、runner に渡す直前」の境界を守る。
 * provisioner が管理下 worktree 外のパスを返した場合に spawn を止めるため、
 * worktreePath が `<repoRoot>/.claude/worktrees/<ticketId>` の形であることも検証する。
 * path.resolve は `..` を正規化するが symlink は追わないため、worktree 配下を指す
 * symlink 経由の迂回はこの関数では検出できない。
 */
export function validateProvisionedRunCwd(
  cwd: string,
  worktreePath: string,
  ticketId: string,
  repoRoot: string,
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

  if (path.resolve(cwd) !== path.resolve(worktreePath)) {
    return 'invalid-request';
  }

  const expected = path.join(
    path.resolve(repoRoot),
    '.claude',
    'worktrees',
    ticketId,
  );
  // path.join normalizes ticketId segments like '..' — reject if basename drifts.
  if (path.basename(expected) !== ticketId) {
    return 'invalid-request';
  }

  if (path.resolve(worktreePath) !== expected) {
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
