// bdboard-sso1.36: agent-run-routes.test.ts (2315行) を #576 の agent-run ルート分割
// (create/read/cancel) に追随して move only 分割したうちの POST /api/runs 系。
// テスト本体 (it の中身) は一字一句変更していない。変更したのは import と、元の
// describe('createAgentRunRoutes') から POST /api/runs 関連の it/describe だけを
// 抽出して包んだ describe('POST /api/runs') の入れ物のみ。共有ヘルパーは
// agent-run-routes-test-support.ts へ移した。
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunOutcome } from '../../application/ports/agent-runner.js';
import type { WorktreeProvisioner } from '../../application/ports/worktree-provisioner.js';
import { createRunStore, type RunStoreRecord } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import { makeTicket } from '../../domain/test-support.js';
import { AGENT_RUN_BODY_MAX_BYTES } from './agent-run-routes.js';
import { AGENT_RUN_RATE_LIMITED } from './agent-run-rate-limit.js';
import {
  NOW,
  LOCAL_ENV,
  withLocalHost,
  withRemoteTunnel,
  postRunsInit,
  managedWorktreePath,
  project,
  createFakeBoardCache,
  allowingWriteAccess,
  makeProvisioner,
  makeRunner,
  makeRoutes,
  seedOpenTicket,
} from './agent-run-routes-test-support.js';

describe('POST /api/runs', () => {
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

  describe('symlinked repo roots (major-1, bdboard-pkr6.17)', () => {
    // provisioner の findExistingWorktreePath() は `git worktree list --porcelain` の
    // realpath 文字列を返すので、scan root が symlink を通るプロジェクト
    // (macOS の /tmp -> /private/tmp など) では再利用時の worktreePath が
    // project.rootPath から組み立てた期待値と文字列一致しない。
    // フィクスチャは path.resolve/join で組み立てる。POSIX 絶対パスのリテラルだと
    // win32 で path.resolve('/tmp/repo') が 'C:\\tmp\\repo' になり、'/tmp/' で前方一致する
    // normalizePath スタブが素通しになって検証にならない。
    const SYMLINK_ROOT = path.resolve('/tmp/repo');
    const REALPATH_ROOT = path.resolve('/private/tmp/repo');
    const TICKET_ID = 'bdboard-symlink';
    const REUSED_WORKTREE_PATH = path.join(
      REALPATH_ROOT,
      '.claude',
      'worktrees',
      TICKET_ID,
    );
    /** realpath(3) のスタブ: SYMLINK_ROOT 配下だけを REALPATH_ROOT 配下へ読み替える。 */
    const normalizePath = (pathValue: string): string =>
      pathValue === SYMLINK_ROOT ||
      pathValue.startsWith(`${SYMLINK_ROOT}${path.sep}`)
        ? `${REALPATH_ROOT}${pathValue.slice(SYMLINK_ROOT.length)}`
        : pathValue;

    function makeReuseSetup() {
      const cache = createFakeBoardCache();
      seedOpenTicket(cache, TICKET_ID, SYMLINK_ROOT);

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
            ticketId: TICKET_ID,
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
          worktreePath: REUSED_WORKTREE_PATH,
          branchName: `bd/${TICKET_ID}`,
          reused: true,
        })),
      });

      return { cache, registry, dispatch, dispatchCalled, worktreeProvisioner };
    }

    it('dispatches a reused worktree whose git-reported path is a realpath', async () => {
      const { cache, registry, dispatch, dispatchCalled, worktreeProvisioner } =
        makeReuseSetup();
      const runStore = createRunStore({ now: () => NOW });

      const { app } = makeRoutes({
        cache,
        registry,
        runStore,
        worktreeProvisioner,
        normalizePath,
      });
      const response = await app.request(
        '/api/runs',
        withLocalHost(postRunsInit(TICKET_ID)),
        LOCAL_ENV,
      );

      expect(response.status).toBe(202);
      await dispatchCalled;
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: TICKET_ID, cwd: REUSED_WORKTREE_PATH }),
        expect.anything(),
      );
      // major-2: 記録された cwd・ガードに通した値・spawn の cwd はすべて同じ runCwd。
      expect(runStore.list({ ticketId: TICKET_ID })[0]?.cwd).toBe(REUSED_WORKTREE_PATH);
    });

    it('fails the same reused run when normalizePath is the identity (the bug being fixed)', async () => {
      const { cache, registry, dispatch, worktreeProvisioner } = makeReuseSetup();
      const runStore = createRunStore({ now: () => NOW });

      const { app } = makeRoutes({
        cache,
        registry,
        runStore,
        worktreeProvisioner,
        normalizePath: (pathValue: string) => pathValue,
      });
      const response = await app.request(
        '/api/runs',
        withLocalHost(postRunsInit(TICKET_ID)),
        LOCAL_ENV,
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'run cwd must be the managed worktree for this ticket',
      });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('still rejects an unmanaged path when normalizePath is injected', async () => {
      const cache = createFakeBoardCache();
      seedOpenTicket(cache, TICKET_ID, SYMLINK_ROOT);
      const dispatch = vi.fn();
      const registry = createAgentRunnerRegistry();
      registry.register(makeRunner(dispatch));
      const worktreeProvisioner = makeProvisioner({
        provision: vi.fn(async () => ({
          ok: true as const,
          worktreePath: path.join(
            path.resolve('/private/tmp/other-repo'),
            '.claude',
            'worktrees',
            TICKET_ID,
          ),
          branchName: `bd/${TICKET_ID}`,
          reused: true,
        })),
      });

      const { app } = makeRoutes({ cache, registry, worktreeProvisioner, normalizePath });
      const response = await app.request(
        '/api/runs',
        withLocalHost(postRunsInit(TICKET_ID)),
        LOCAL_ENV,
      );

      expect(response.status).toBe(500);
      expect(dispatch).not.toHaveBeenCalled();
    });
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
