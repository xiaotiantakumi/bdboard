// bdboard-sso1.81: agent-run-routes-test-support.ts のモジュール分割 (move only) で
// 切り出した、run 実行に関わるポート (WriteGuardDeps/WorktreeProvisioner/
// IssueWriterPort/AgentRunner) のテスト用フェイク置き場。
import { vi } from 'vitest';
import type { AgentRunner } from '../../../application/ports/agent-runner.js';
import type { IssueWriterPort } from '../../../application/ports/issue-writer.js';
import type { WorktreeProvisioner } from '../../../application/ports/worktree-provisioner.js';
import type { WriteGuardDeps } from '../write-guard.js';

export function allowingWriteAccess(overrides: Partial<WriteGuardDeps> = {}): WriteGuardDeps {
  return {
    isTunnelWriteAllowed: () => true,
    hasTunnelSession: () => true,
    ...overrides,
  };
}

export function makeProvisioner(
  overrides: Partial<WorktreeProvisioner> = {},
): WorktreeProvisioner {
  return {
    provision: vi.fn(async ({ repoRootPath, ticketId }) => ({
      ok: true as const,
      worktreePath: `${repoRootPath}/.claude/worktrees/${ticketId}`,
      branchName: `bd/${ticketId}`,
      reused: false,
    })),
    ...overrides,
  };
}

/**
 * run 開始時の claim (bdboard-pkr6.26) のテスト用フェイク。既定は claim/unclaim とも
 * 無条件成功 (他の quick-action 相当メソッドは呼ばれない想定のスタブ)。claim の失敗や
 * unclaim の呼び出し検証をしたいテストだけ overrides で差し替える。
 */
export function makeIssueWriter(
  overrides: Partial<IssueWriterPort> = {},
): IssueWriterPort {
  return {
    claim: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    defer: vi.fn(async () => {}),
    setPriority: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    reopen: vi.fn(async () => {}),
    unclaim: vi.fn(async () => {}),
    undefer: vi.fn(async () => {}),
    undoPriority: vi.fn(async () => {}),
    updateTitle: vi.fn(async () => {}),
    updateDescription: vi.fn(async () => {}),
    ...overrides,
  };
}

export function makeRunner(dispatch: AgentRunner['dispatch']): AgentRunner {
  return {
    id: 'claude-spawn',
    experimental: false,
    supports: () => true,
    dispatch,
  };
}
