import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AgentRunner, RunOutcome } from '../../application/ports/agent-runner.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import type { WorktreeProvisioner } from '../../application/ports/worktree-provisioner.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../../application/ports/board-cache-fakes.js';
import { createRunStore, type RunStoreRecord } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import { createAgentRunRoutes, AGENT_RUN_BODY_MAX_BYTES } from './agent-run-routes.js';
import { AGENT_RUN_RATE_LIMITED } from './agent-run-rate-limit.js';
import type { WriteGuardDeps } from './write-guard.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DEFAULT_REPO_ROOT = '/projects/bdboard';
const LOCAL_HOST = 'localhost:8787';
const LOCAL_ENV = {
  incoming: {
    socket: {
      remoteAddress: '127.0.0.1',
      localPort: 8787,
    },
  },
};
const CF_HEADER = { 'CF-Ray': 'abc123-NRT' } as const;
const SESSION_COOKIE = 'bdboard_tunnel_session=example-session-value';

function withLocalHost(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

function withRemoteTunnel(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('CF-Ray', CF_HEADER['CF-Ray']);
  headers.set('Cookie', SESSION_COOKIE);
  if (!headers.has('Host')) {
    headers.set('Host', LOCAL_HOST);
  }
  return { ...init, headers };
}

function postRunsInit(
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

function managedWorktreePath(
  ticketId: string,
  repoRoot = DEFAULT_REPO_ROOT,
): string {
  return `${repoRoot}/.claude/worktrees/${ticketId}`;
}

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function createFakeBoardCache(): BoardCache & { readonly entries: Map<string, CachedProject> } {
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

function allowingWriteAccess(overrides: Partial<WriteGuardDeps> = {}): WriteGuardDeps {
  return {
    isTunnelWriteAllowed: () => true,
    hasTunnelSession: () => true,
    ...overrides,
  };
}

function makeProvisioner(
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

function makeRunner(dispatch: AgentRunner['dispatch']): AgentRunner {
  return {
    id: 'claude-spawn',
    experimental: false,
    supports: () => true,
    dispatch,
  };
}

function makeRoutes(deps: Partial<Parameters<typeof createAgentRunRoutes>[0]> = {}) {
  const cache = deps.cache ?? createFakeBoardCache();
  const registry = deps.registry ?? createAgentRunnerRegistry();
  const runStore = deps.runStore ?? createRunStore({ now: () => NOW });
  const worktreeProvisioner = deps.worktreeProvisioner ?? makeProvisioner();

  const app = createAgentRunRoutes({
    cache,
    registry,
    runStore,
    worktreeProvisioner,
    writeAccess: deps.writeAccess,
    isRemoteAgentRunAllowed: deps.isRemoteAgentRunAllowed ?? (async () => true),
    now: deps.now ?? (() => NOW),
    ...deps,
  });

  return { app, cache, registry, runStore, worktreeProvisioner };
}

function seedOpenTicket(
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

const EXPECTED_API_RUNS_ROUTES = [
  { method: 'POST', path: '/api/runs' },
  { method: 'GET', path: '/api/runs' },
  { method: 'GET', path: '/api/runs/:runId' },
  { method: 'POST', path: '/api/runs/:runId/cancel' },
] as const;

function collectApiRunsRoutes(app: Hono): Array<{ method: string; path: string }> {
  return app.routes
    .filter(
      (route) =>
        route.path.startsWith('/api/runs') &&
        route.method !== 'ALL' &&
        route.method !== '*',
    )
    .map(({ method, path: routePath }) => ({ method, path: routePath }));
}

function materializeRoutePath(routePath: string): string {
  return routePath.replace(':runId', 'run-x');
}

function requestInitForApiRunsRoute(route: {
  method: string;
  path: string;
}): RequestInit {
  const headers = new Headers({
    ...CF_HEADER,
    Cookie: SESSION_COOKIE,
  });

  if (route.method === 'POST' && route.path === '/api/runs') {
    headers.set('content-type', 'application/json');
    return {
      method: route.method,
      headers,
      body: JSON.stringify({ ticketId: 'bdboard-ok' }),
    };
  }

  return { method: route.method, headers };
}

describe('createAgentRunRoutes', () => {
  it('returns 404 when ticket is unknown', async () => {
    const { app } = makeRoutes();
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-missing' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(404);
  });

  it('returns 409 when ticket is blocked, deferred, or closed', async () => {
    const cache = createFakeBoardCache();
    const proj = project('proj-1', '/projects/bdboard');
    cache.putProject({
      project: proj,
      tickets: [
        makeTicket({
          id: 'bdboard-blocked',
          projectId: proj.id,
          status: 'open',
          dependencies: [
            {
              kind: 'blocks',
              issueId: 'bdboard-blocked',
              dependsOnId: 'bdboard-blocker',
            },
          ],
        }),
        makeTicket({ id: 'bdboard-blocker', projectId: proj.id, status: 'open' }),
        makeTicket({
          id: 'bdboard-deferred',
          projectId: proj.id,
          status: 'open',
          deferUntil: new Date('2099-01-01T00:00:00.000Z'),
        }),
        makeTicket({ id: 'bdboard-closed', projectId: proj.id, status: 'closed' }),
      ],
      fingerprint: 'fp',
      fetchedAt: NOW,
    });

    const { app } = makeRoutes({ cache });

    const blocked = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-blocked' }),
      }),
      LOCAL_ENV,
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      error: 'ticket is blocked',
      reason: 'blocked',
    });

    const deferred = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-deferred' }),
      }),
      LOCAL_ENV,
    );
    expect(deferred.status).toBe(409);
    expect(await deferred.json()).toEqual({
      error: 'ticket is deferred',
      reason: 'deferred',
    });

    const closed = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-closed' }),
      }),
      LOCAL_ENV,
    );
    expect(closed.status).toBe(409);
    expect(await closed.json()).toEqual({
      error: 'ticket is closed',
      reason: 'closed',
    });
  });

  it('returns 409 when a run is already in progress for the ticket', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-running');
    const runStore = createRunStore({ now: () => NOW });
    runStore.start({
      id: 'existing-run',
      ticketId: 'bdboard-running',
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd: '/tmp/existing',
    });

    const { app } = makeRoutes({ cache, runStore });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-running' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'run already in progress',
      reason: 'already-running',
    });
  });

  it('returns 429 when too many concurrent runs are active', async () => {
    const runStore = {
      canStart: vi.fn(() => ({ ok: false as const, reason: 'too-many-runs' as const })),
      start: vi.fn(),
      updateCwd: vi.fn(),
      appendChunk: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(() => [] as RunStoreRecord[]),
      cancelAllAndWait: vi.fn(async () => {}),
      get: vi.fn(),
      list: vi.fn(() => []),
      getAbortSignal: vi.fn(),
    };

    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-ok');

    const { app } = makeRoutes({ cache, runStore });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-ok' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'too many concurrent runs',
      reason: 'too-many-runs',
    });
  });

  it('returns 409 for a second POST while the first is still provisioning the same ticket', async () => {
    type ProvisionResult = Awaited<ReturnType<WorktreeProvisioner['provision']>>;
    let resolveProvision!: (value: ProvisionResult) => void;
    const provisionPromise = new Promise<ProvisionResult>((resolve) => {
      resolveProvision = resolve;
    });

    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-race');

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(() => provisionPromise),
    });

    const { app } = makeRoutes({ cache, worktreeProvisioner });

    const firstRequest = app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-race' }),
      }),
      LOCAL_ENV,
    );

    const secondResponse = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-race' }),
      }),
      LOCAL_ENV,
    );

    expect(secondResponse.status).toBe(409);
    expect(await secondResponse.json()).toEqual({
      error: 'run already in progress',
      reason: 'already-running',
    });

    resolveProvision({
      ok: true,
      worktreePath: managedWorktreePath('bdboard-race'),
      branchName: 'bd/bdboard-race',
      reused: false,
    });

    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(202);
  });

  it('returns 429 for a second concurrent POST when maxConcurrent is 1', async () => {
    type ProvisionResult = Awaited<ReturnType<WorktreeProvisioner['provision']>>;
    let resolveProvision!: (value: ProvisionResult) => void;
    const provisionPromise = new Promise<ProvisionResult>((resolve) => {
      resolveProvision = resolve;
    });

    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-a');
    seedOpenTicket(cache, 'bdboard-b');

    const runStore = createRunStore({ maxConcurrent: 1, now: () => NOW });
    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(() => provisionPromise),
    });

    const { app } = makeRoutes({ cache, runStore, worktreeProvisioner });

    const firstRequest = app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-a' }),
      }),
      LOCAL_ENV,
    );

    const secondResponse = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-b' }),
      }),
      LOCAL_ENV,
    );

    expect(secondResponse.status).toBe(429);
    expect(await secondResponse.json()).toEqual({
      error: 'too many concurrent runs',
      reason: 'too-many-runs',
    });

    resolveProvision({
      ok: true,
      worktreePath: managedWorktreePath('bdboard-a'),
      branchName: 'bd/bdboard-a',
      reused: false,
    });

    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(202);
  });

  it('generates distinct run ids when started at the same instant', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-id');

    const dispatch = vi.fn(async (): Promise<RunOutcome> => ({
      ok: true,
      run: {
        id: 'ignored',
        ticketId: 'bdboard-id',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'succeeded',
        startedAt: NOW,
        finishedAt: NOW,
      },
    }));

    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const runStore = createRunStore({ maxConcurrent: 2, now: () => NOW });
    const { app } = makeRoutes({ cache, registry, runStore });

    const firstResponse = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-id' }),
      }),
      LOCAL_ENV,
    );
    expect(firstResponse.status).toBe(202);
    const firstBody = await firstResponse.json();
    runStore.finish(firstBody.runId, {
      ok: true,
      run: {
        id: firstBody.runId,
        ticketId: 'bdboard-id',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'succeeded',
        startedAt: NOW,
        finishedAt: NOW,
      },
    });

    const secondResponse = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-id' }),
      }),
      LOCAL_ENV,
    );
    expect(secondResponse.status).toBe(202);
    const secondBody = await secondResponse.json();

    expect(firstBody.runId).not.toBe(secondBody.runId);
  });

  it('returns 409 when worktree provisioning finds uncommitted changes', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-dirty');

    const runStore = createRunStore({ now: () => NOW });
    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: false as const,
        reason: 'worktree-dirty' as const,
        message: `${managedWorktreePath('bdboard-dirty')}: uncommitted changes prevent agent run`,
      })),
    });

    const { app } = makeRoutes({ cache, runStore, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-dirty' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: `${managedWorktreePath('bdboard-dirty')}: uncommitted changes prevent agent run`,
      // 兄弟の 409 と同じく機械可読な `reason` を返す。UI は可変長のメッセージ
      // ではなくこのトークンで分岐する。
      reason: 'worktree-dirty',
    });
    const runs = runStore.list({ ticketId: 'bdboard-dirty' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
  });

  it('returns 409 when worktree provisioning finds a branch mismatch', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-branch');

    const runStore = createRunStore({ now: () => NOW });
    const mismatchMessage =
      `${managedWorktreePath('bdboard-branch')}: on branch main, expected bd/bdboard-branch`;
    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: false as const,
        reason: 'worktree-branch-mismatch' as const,
        message: mismatchMessage,
      })),
    });

    const { app } = makeRoutes({ cache, runStore, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-branch' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: mismatchMessage,
      reason: 'worktree-branch-mismatch',
    });
    const runs = runStore.list({ ticketId: 'bdboard-branch' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
  });

  it('returns 409 when the retained agent-run worktree limit is reached', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-cap');

    const runStore = createRunStore({ now: () => NOW });
    const limitMessage =
      'agent-run worktree limit reached (20); finish, merge, or manually remove an existing worktree before retrying';
    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: false as const,
        reason: 'worktree-limit-reached' as const,
        message: limitMessage,
      })),
    });

    const { app } = makeRoutes({ cache, runStore, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-cap')),
      LOCAL_ENV,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: limitMessage,
      reason: 'worktree-limit-reached',
    });
    expect(runStore.list({ ticketId: 'bdboard-cap' })[0]?.status).toBe('failed');
  });

  it('returns 500 and releases the run slot when provisioning throws', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-throw');

    const runStore = createRunStore({ now: () => NOW });
    const worktreeProvisioner = makeProvisioner({
      provision: vi
        .fn()
        .mockRejectedValueOnce(new Error('provisioner exploded'))
        .mockResolvedValueOnce({
          ok: true as const,
          worktreePath: managedWorktreePath('bdboard-throw'),
          branchName: 'bd/bdboard-throw',
          reused: false,
        }),
    });

    const registry = createAgentRunnerRegistry();
    registry.register(
      makeRunner(async () => ({
        ok: true,
        run: {
          id: 'ignored',
          ticketId: 'bdboard-throw',
          runner: 'claude-spawn',
          mode: 'spawn',
          status: 'succeeded',
          startedAt: NOW,
          finishedAt: NOW,
        },
      })),
    );

    const { app } = makeRoutes({ cache, runStore, worktreeProvisioner, registry });

    const firstResponse = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-throw' }),
      }),
      LOCAL_ENV,
    );

    expect(firstResponse.status).toBe(500);
    expect(await firstResponse.json()).toEqual({ error: 'provisioner exploded' });
    expect(runStore.list({ ticketId: 'bdboard-throw' })[0]?.status).toBe('failed');

    const secondResponse = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-throw' }),
      }),
      LOCAL_ENV,
    );
    expect(secondResponse.status).toBe(202);
  });

  it('records a failed run when worktree provisioning fails', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-fail');

    const runStore = createRunStore({ now: () => NOW });
    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: false as const,
        reason: 'git-failed' as const,
        message: 'git worktree add failed',
      })),
    });

    const { app } = makeRoutes({ cache, runStore, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-fail' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(500);
    const runs = runStore.list({ ticketId: 'bdboard-fail' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toBe('git worktree add failed');
  });

  it('returns 202 with worktreePath, branchName, reused, and pending status on success', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-ok');

    const dispatch = vi.fn(async (): Promise<RunOutcome> => ({
      ok: true,
      run: {
        id: 'ignored',
        ticketId: 'bdboard-ok',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'succeeded',
        startedAt: NOW,
        finishedAt: NOW,
      },
    }));

    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: managedWorktreePath('bdboard-ok'),
        branchName: 'bd/bdboard-ok',
        reused: false,
      })),
    });

    const { app } = makeRoutes({ cache, registry, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-ok' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ticketId: 'bdboard-ok',
      status: 'pending',
      worktreePath: managedWorktreePath('bdboard-ok'),
      branchName: 'bd/bdboard-ok',
      reused: false,
    });
    expect(typeof body.runId).toBe('string');
  });

  it('passes the provisioned worktree path as cwd to the runner', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-cwd');

    const worktreePath = managedWorktreePath('bdboard-cwd');
    let resolveDispatch!: () => void;
    const dispatchCalled = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });

    const dispatch = vi.fn(async (): Promise<RunOutcome> => {
      resolveDispatch();
      return {
        ok: true,
        run: {
          id: 'ignored',
          ticketId: 'bdboard-cwd',
          runner: 'claude-spawn',
          mode: 'spawn',
          status: 'succeeded',
          startedAt: NOW,
          finishedAt: NOW,
        },
      };
    });

    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath,
        branchName: 'bd/bdboard-cwd',
        reused: false,
      })),
    });

    const { app } = makeRoutes({ cache, registry, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-cwd')),
      LOCAL_ENV,
    );

    expect(response.status).toBe(202);
    await dispatchCalled;
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'bdboard-cwd',
        cwd: worktreePath,
      }),
      expect.objectContaining({
        onChunk: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('returns 500 and does not dispatch when provisioner returns an unmanaged worktree path', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-evil');

    const dispatch = vi.fn();
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const runStore = createRunStore({ now: () => NOW });
    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: '/tmp/evil',
        branchName: 'bd/bdboard-evil',
        reused: false,
      })),
    });

    const { app } = makeRoutes({ cache, registry, runStore, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-evil')),
      LOCAL_ENV,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'run cwd must be the managed worktree for this ticket',
    });
    expect(dispatch).not.toHaveBeenCalled();
    const runs = runStore.list({ ticketId: 'bdboard-evil' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toBe('run cwd must be the managed worktree for this ticket');
  });

  it('returns reused true when an existing clean worktree is provisioned', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-reuse');

    const dispatch = vi.fn(async (): Promise<RunOutcome> => ({
      ok: true,
      run: {
        id: 'ignored',
        ticketId: 'bdboard-reuse',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'succeeded',
        startedAt: NOW,
        finishedAt: NOW,
      },
    }));

    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: managedWorktreePath('bdboard-reuse'),
        branchName: 'bd/bdboard-reuse',
        reused: true,
      })),
    });

    const { app } = makeRoutes({ cache, registry, worktreeProvisioner });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticketId: 'bdboard-reuse' }),
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      ticketId: 'bdboard-reuse',
      status: 'pending',
      reused: true,
    });
  });

  it('lists runs newest-first and returns run detail with tailed log', async () => {
    const runStore = createRunStore({ now: () => NOW });
    runStore.start({
      id: 'run-old',
      ticketId: 'bdboard-old',
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd: '/tmp/old',
      startedAt: new Date('2026-06-01T10:00:00.000Z'),
    });
    runStore.appendChunk('run-old', { stream: 'stdout', text: 'older-output' });
    runStore.finish('run-old', {
      ok: true,
      run: {
        id: 'run-old',
        ticketId: 'bdboard-old',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'succeeded',
        startedAt: new Date('2026-06-01T10:00:00.000Z'),
        finishedAt: new Date('2026-06-01T10:05:00.000Z'),
      },
    });

    runStore.start({
      id: 'run-new',
      ticketId: 'bdboard-new',
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd: '/tmp/new',
      startedAt: new Date('2026-06-01T11:00:00.000Z'),
    });
    runStore.appendChunk('run-new', { stream: 'stderr', text: 'fresh-log' });

    const { app } = makeRoutes({ runStore });

    const listResponse = await app.request('/api/runs', withLocalHost(), LOCAL_ENV);
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.runs.map((run: { id: string }) => run.id)).toEqual(['run-new', 'run-old']);
    expect(listBody.runs[0]).not.toHaveProperty('log');

    const detailResponse = await app.request('/api/runs/run-new', withLocalHost(), LOCAL_ENV);
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.log).toContain('fresh-log');
    expect(detailBody.cwd).toBe('/tmp/new');

    const missingResponse = await app.request('/api/runs/missing-run', withLocalHost(), LOCAL_ENV);
    expect(missingResponse.status).toBe(404);
  });

  it('returns run detail log and cwd only for local access', async () => {
    const runStore = createRunStore({ now: () => NOW });
    runStore.start({
      id: 'run-restricted',
      ticketId: 'bdboard-restricted',
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd: '/tmp/restricted',
      startedAt: NOW,
    });
    runStore.appendChunk('run-restricted', { stream: 'stdout', text: 'secret-log-line' });

    const { app } = makeRoutes({
      runStore,
      writeAccess: allowingWriteAccess(),
      isRemoteAgentRunAllowed: async () => true,
    });

    const remoteResponse = await app.request(
      '/api/runs/run-restricted',
      withRemoteTunnel(),
      LOCAL_ENV,
    );
    expect(remoteResponse.status).toBe(200);
    const remoteBody = await remoteResponse.json();
    expect(remoteBody).toMatchObject({
      id: 'run-restricted',
      log: '',
      logRestricted: true,
    });
    expect(remoteBody).not.toHaveProperty('cwd');

    const localResponse = await app.request(
      '/api/runs/run-restricted',
      withLocalHost(),
      LOCAL_ENV,
    );
    expect(localResponse.status).toBe(200);
    const localBody = await localResponse.json();
    expect(localBody.log).toContain('secret-log-line');
    expect(localBody.cwd).toBe('/tmp/restricted');
    expect(localBody).not.toHaveProperty('logRestricted');
  });

  it('cancels a running run and rejects unknown or finished runs', async () => {
    const runStore = createRunStore({ now: () => NOW });
    runStore.start({
      id: 'run-live',
      ticketId: 'bdboard-live',
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd: '/tmp/live',
    });
    runStore.finish('run-live', {
      ok: true,
      run: {
        id: 'run-live',
        ticketId: 'bdboard-live',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'succeeded',
        startedAt: NOW,
        finishedAt: NOW,
      },
    });

    const { app, runStore: store } = makeRoutes({ runStore });

    const unknown = await app.request(
      '/api/runs/unknown/cancel',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    expect(unknown.status).toBe(404);

    const finished = await app.request(
      '/api/runs/run-live/cancel',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    expect(finished.status).toBe(409);

    store.start({
      id: 'run-active',
      ticketId: 'bdboard-active',
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd: '/tmp/active',
    });

    const cancel = await app.request(
      '/api/runs/run-active/cancel',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toEqual({ runId: 'run-active', status: 'cancelling' });
    expect(store.get('run-active')?.status).toBe('cancelling');

    const cancelAgain = await app.request(
      '/api/runs/run-active/cancel',
      withLocalHost({ method: 'POST' }),
      LOCAL_ENV,
    );
    expect(cancelAgain.status).toBe(409);
  });

  it('blocks all /api/runs routes for remote requests when remote agent runs are disabled', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-ok');

    const dispatch = vi.fn();
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const runStore = {
      canStart: vi.fn(() => ({ ok: true as const })),
      start: vi.fn(),
      updateCwd: vi.fn(),
      appendChunk: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(() => [] as RunStoreRecord[]),
      cancelAllAndWait: vi.fn(async () => {}),
      get: vi.fn(),
      list: vi.fn(() => []),
      getAbortSignal: vi.fn(),
    };

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(),
    });

    const { app } = makeRoutes({
      cache,
      registry,
      runStore,
      worktreeProvisioner,
      writeAccess: allowingWriteAccess(),
      isRemoteAgentRunAllowed: async () => false,
    });

    const routes = collectApiRunsRoutes(app);
    expect(routes.length).toBeGreaterThan(0);

    for (const expected of EXPECTED_API_RUNS_ROUTES) {
      expect(
        routes.some(
          (route) => route.method === expected.method && route.path === expected.path,
        ),
        `expected ${expected.method} ${expected.path} to be registered`,
      ).toBe(true);
    }

    for (const route of routes) {
      const response = await app.request(
        materializeRoutePath(route.path),
        requestInitForApiRunsRoute(route),
        LOCAL_ENV,
      );

      expect(response.status, `${route.method} ${route.path} must be blocked`).toBe(403);
      expect(await response.json()).toEqual({ error: 'remote agent runs are disabled' });
    }

    expect(dispatch).not.toHaveBeenCalled();
    expect(worktreeProvisioner.provision).not.toHaveBeenCalled();
    expect(runStore.canStart).not.toHaveBeenCalled();
    expect(runStore.start).not.toHaveBeenCalled();
    expect(runStore.updateCwd).not.toHaveBeenCalled();
    expect(runStore.appendChunk).not.toHaveBeenCalled();
    expect(runStore.finish).not.toHaveBeenCalled();
    expect(runStore.cancel).not.toHaveBeenCalled();
    expect(runStore.cancelAll).not.toHaveBeenCalled();
    expect(runStore.cancelAllAndWait).not.toHaveBeenCalled();
    expect(runStore.get).not.toHaveBeenCalled();
    expect(runStore.list).not.toHaveBeenCalled();
    expect(runStore.getAbortSignal).not.toHaveBeenCalled();
  });

  it('returns 429 with Retry-After when remote POST /api/runs exceeds rate limit', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-rate');

    const runStore = createRunStore({ now: () => NOW });
    const worktreeProvisioner = makeProvisioner();
    const startSpy = vi.spyOn(runStore, 'start');
    const provisionSpy = vi.spyOn(worktreeProvisioner, 'provision');

    const { app } = makeRoutes({
      cache,
      runStore,
      worktreeProvisioner,
      writeAccess: allowingWriteAccess(),
      isRemoteAgentRunAllowed: async () => true,
      rateLimit: { perMinute: 1 },
    });

    const firstResponse = await app.request(
      '/api/runs',
      withRemoteTunnel(postRunsInit('bdboard-rate')),
      LOCAL_ENV,
    );
    expect(firstResponse.status).toBe(202);

    const secondResponse = await app.request(
      '/api/runs',
      withRemoteTunnel(postRunsInit('bdboard-rate')),
      LOCAL_ENV,
    );
    expect(secondResponse.status).toBe(429);
    expect(await secondResponse.json()).toEqual({ error: AGENT_RUN_RATE_LIMITED });
    expect(secondResponse.headers.get('Retry-After')).toMatch(/^\d+$/);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(provisionSpy).toHaveBeenCalledTimes(1);
  });

  it('does not count local direct POST /api/runs toward rate limit', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-local-rate');

    const runStore = createRunStore({ maxConcurrent: 10, now: () => NOW });
    const worktreeProvisioner = makeProvisioner();

    const { app } = makeRoutes({
      cache,
      runStore,
      worktreeProvisioner,
      rateLimit: { perMinute: 1 },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.request(
        '/api/runs',
        withLocalHost(postRunsInit('bdboard-local-rate')),
        LOCAL_ENV,
      );
      expect(response.status).toBe(202);
      const body = await response.json();
      runStore.finish(body.runId, {
        ok: true,
        run: {
          id: body.runId,
          ticketId: 'bdboard-local-rate',
          runner: 'claude-spawn',
          mode: 'spawn',
          status: 'succeeded',
          startedAt: NOW,
          finishedAt: NOW,
        },
      });
    }
  });

  it('returns 413 when POST /api/runs body exceeds AGENT_RUN_BODY_MAX_BYTES', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-body');

    const runStore = {
      canStart: vi.fn(() => ({ ok: true as const })),
      start: vi.fn(),
      updateCwd: vi.fn(),
      appendChunk: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(() => [] as RunStoreRecord[]),
      cancelAllAndWait: vi.fn(async () => {}),
      get: vi.fn(),
      list: vi.fn(() => []),
      getAbortSignal: vi.fn(),
    };

    const { app } = makeRoutes({ cache, runStore });

    const oversizedBody = JSON.stringify({
      ticketId: 'x'.repeat(AGENT_RUN_BODY_MAX_BYTES),
    });
    const response = await app.request(
      '/api/runs',
      withLocalHost({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversizedBody,
      }),
      LOCAL_ENV,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request body too large' });
    expect(runStore.canStart).not.toHaveBeenCalled();
  });

  it('does not build readiness context when canStart rejects with too-many-runs', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-ok');
    const listProjects = vi.fn(cache.listProjects.bind(cache));
    const cacheWithSpy = { ...cache, listProjects };

    const rejectingRunStore = {
      canStart: vi.fn(() => ({ ok: false as const, reason: 'too-many-runs' as const })),
      start: vi.fn(),
      updateCwd: vi.fn(),
      appendChunk: vi.fn(),
      finish: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(() => [] as RunStoreRecord[]),
      cancelAllAndWait: vi.fn(async () => {}),
      get: vi.fn(),
      list: vi.fn(() => []),
      getAbortSignal: vi.fn(),
    };

    const { app: rejectingApp } = makeRoutes({
      cache: cacheWithSpy,
      runStore: rejectingRunStore,
    });
    const rejectingResponse = await rejectingApp.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-ok')),
      LOCAL_ENV,
    );
    expect(rejectingResponse.status).toBe(429);
    const rejectingListProjectsCalls = listProjects.mock.calls.length;

    const successCache = createFakeBoardCache();
    seedOpenTicket(successCache, 'bdboard-success');
    const successListProjects = vi.fn(successCache.listProjects.bind(successCache));
    const successCacheWithSpy = { ...successCache, listProjects: successListProjects };

    const { app: successApp } = makeRoutes({ cache: successCacheWithSpy });
    const successResponse = await successApp.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-success')),
      LOCAL_ENV,
    );
    expect(successResponse.status).toBe(202);
    const successListProjectsCalls = successListProjects.mock.calls.length;

    expect(rejectingListProjectsCalls).toBeLessThan(successListProjectsCalls);
    expect(successListProjectsCalls - rejectingListProjectsCalls).toBe(1);
  });
});

describe('createAgentRunRoutes guard mount scope', () => {
  it('does not leak the agent-run guard onto routes registered after the mount', async () => {
    const parent = new Hono();
    parent.route(
      '/',
      createAgentRunRoutes({
        cache: createFakeBoardCache(),
        registry: createAgentRunnerRegistry(),
        runStore: createRunStore({ now: () => NOW }),
        worktreeProvisioner: makeProvisioner(),
        writeAccess: allowingWriteAccess(),
        isRemoteAgentRunAllowed: async () => false,
        now: () => NOW,
      }),
    );
    // main.ts の serveStatic / SPA フォールバックと同じ「後から登録される '*' ハンドラ」
    parent.get('/api/tunnel/status', (c) => c.json({ running: false }));
    parent.get('*', (c) => c.html('<html>spa</html>'));

    for (const path of ['/', '/assets/index.js', '/api/tunnel/status']) {
      const response = await parent.request(path, withRemoteTunnel());
      expect(response.status).toBe(200);
    }

    const guarded = await parent.request(
      '/api/runs',
      withRemoteTunnel(postRunsInit('bdboard-x')),
    );
    expect(guarded.status).toBe(403);
  });
});
