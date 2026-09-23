// bdboard-sso1.81: agent-run-routes-test-support.ts のモジュール分割 (move only) で
// 切り出した、fetch の RequestInit を組み立てるテスト用ヘルパー置き場。
import { CF_HEADER, DEFAULT_REPO_ROOT, LOCAL_HOST, SESSION_COOKIE } from './constants.js';

export function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

export function withRemoteTunnel(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('CF-Ray', CF_HEADER['CF-Ray']);
  headers.set('Cookie', SESSION_COOKIE);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

export function postRunsInit(
  ticketId: string,
  init: RequestInit = {},
): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return {
    ...init,
    method: 'POST',
    headers,
    body: JSON.stringify({ ticketId }),
  };
}

export function managedWorktreePath(
  ticketId: string,
  repoRoot = DEFAULT_REPO_ROOT,
): string {
  return `${repoRoot}/.claude/worktrees/${ticketId}`;
}
