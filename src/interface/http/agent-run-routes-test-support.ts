// bdboard-sso1.36: agent-run-routes.test.ts の分割 (bdboard-sso1.27 の agent-run
// ルートモジュール分割 create/read/cancel に追随) で複数のリソース別テストファイルから
// 共有される、非テストのヘルパー/フィクスチャ置き場。中身 (withLocalHost/
// createFakeBoardCache/makeRoutes/seedOpenTicket 等) は元の agent-run-routes.test.ts
// から一字一句変更せず移動しただけ (move only)。export の付与とインデント調整のみ加えた。
import { vi } from 'vitest';
import type { AgentRunner } from '../../application/ports/agent-runner.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { WorktreeProvisioner } from '../../application/ports/worktree-provisioner.js';
import {
  createEmptyCfdCacheMethods,
  createEmptyInteractionsCacheMethods,
  createEmptySessionLinksCacheMethods,
} from '../../application/ports/board-cache-fakes.js';
import { createRunStore } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import { compareStrings } from '../../domain/compare.js';
import type { ContractState } from '../../domain/harness-contract.js';
import type {
  ProjectHarnessPackStatus,
  ProjectHarnessStatus,
} from '../../domain/harness-pack.js';
import { RUN_REQUIRED_PACK_NAME } from '../../domain/harness-run-preflight.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import { createAgentRunRoutes } from './agent-run-routes.js';
import type { WriteGuardDeps } from './write-guard.js';

export const NOW = new Date('2026-06-01T12:00:00.000Z');
export const DEFAULT_REPO_ROOT = '/projects/bdboard';
export const LOCAL_HOST = 'localhost:8787';
export const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};
export const CF_HEADER = { 'CF-Ray': 'abc123-NRT' } as const;
export const SESSION_COOKIE = 'bdboard_tunnel_session=example-session-value';

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

export function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

export function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
  const entries = new Map<string, CachedProject>();

  return {
    entries,
    getProject(projectId: string): CachedProject | undefined {
      return entries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      entries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...entries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      entries.delete(projectId);
    },
    clear(): void {
      entries.clear();
    },
    getTranscriptOffset(): number | undefined {
      return undefined;
    },
    setTranscriptOffset(): void {},
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

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

export const READY_CONTRACT: ContractState = {
  state: 'ok',
  verify: 'npm run verify',
  prFlow: 'pr',
  mainBranch: 'main',
  models: null,
  expiredExcludeCount: 0,
  modelExclusionWarnings: [],
};

export function harnessPack(
  overrides: Partial<ProjectHarnessPackStatus> = {},
): ProjectHarnessPackStatus {
  return {
    name: RUN_REQUIRED_PACK_NAME,
    availableVersion: '1.0.0',
    installedVersion: '1.0.0',
    drift: false,
    hooksState: 'ok',
    missingHooks: [],
    ...overrides,
  };
}

/**
 * preflight を満たすハーネス状態 (bdboard-pkr6.11)。既定でこれを返すのは、
 * preflight 以外のテストが「前提は揃っている」前提で書かれているため。
 * preflight そのものを見るテストだけが `getHarnessStatus` を差し替える。
 */
export function readyHarnessStatus(
  packOverrides: Partial<ProjectHarnessPackStatus> = {},
  contract: ContractState = READY_CONTRACT,
): ProjectHarnessStatus {
  return { packs: [harnessPack(packOverrides)], contract };
}

export function makeRoutes(deps: Partial<Parameters<typeof createAgentRunRoutes>[0]> = {}) {
  const cache = deps.cache ?? createFakeBoardCache();
  const registry = deps.registry ?? createAgentRunnerRegistry();
  const runStore = deps.runStore ?? createRunStore({ now: () => NOW });
  const worktreeProvisioner = deps.worktreeProvisioner ?? makeProvisioner();
  const issueWriter = deps.issueWriter ?? makeIssueWriter();

  const app = createAgentRunRoutes({
    cache,
    registry,
    runStore,
    worktreeProvisioner,
    // normalizePath は必須依存。正規化を要らないテストは恒等関数を明示的に渡す。
    normalizePath: deps.normalizePath ?? ((pathValue: string) => pathValue),
    writeAccess: deps.writeAccess,
    getHarnessStatus: deps.getHarnessStatus ?? (async () => readyHarnessStatus()),
    isRemoteAgentRunAllowed: deps.isRemoteAgentRunAllowed ?? (async () => true),
    now: deps.now ?? (() => NOW),
    issueWriter,
    ...deps,
  });

  return { app, cache, registry, runStore, worktreeProvisioner, issueWriter };
}

export function seedOpenTicket(
  cache: BoardCache,
  ticketId: string,
  rootPath = DEFAULT_REPO_ROOT,
): void {
  const proj = project('proj-1', rootPath);
  const existing = cache.getProject(proj.id);
  const ticket = makeTicket({
    id: ticketId,
    projectId: proj.id,
    title: 'Example ticket',
    status: 'open',
  });
  cache.putProject({
    project: proj,
    tickets: existing ? [...existing.tickets, ticket] : [ticket],
    fingerprint: 'fp',
    fetchedAt: NOW,
  });
}

