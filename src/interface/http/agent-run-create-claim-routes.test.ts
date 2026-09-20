// bdboard-sso1.36: agent-run-routes.test.ts (2315行) を #576 の agent-run ルート分割
// (create/read/cancel) に追随して move only 分割したうちの、POST /api/runs 実行時の
// チケット claim (bdboard-pkr6.26) とハーネス preflight (bdboard-pkr6.11) 関連。
// テスト本体は一字一句変更していない。変更したのは import のみ (describe はどちらも
// 元のタイトルのまま移動)。共有ヘルパーは agent-run-routes-test-support.ts へ移した。
import { describe, expect, it, vi } from 'vitest';
import type { RunOutcome } from '../../application/ports/agent-runner.js';
import { createRunStore } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import type { ContractState } from '../../domain/harness-contract.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import {
  NOW,
  LOCAL_ENV,
  withLocalHost,
  postRunsInit,
  managedWorktreePath,
  createFakeBoardCache,
  makeProvisioner,
  makeIssueWriter,
  makeRunner,
  readyHarnessStatus,
  makeRoutes,
  seedOpenTicket,
} from './agent-run-routes-test-support.js';

describe('createAgentRunRoutes ticket claim on run start (bdboard-pkr6.26)', () => {
  it('claims the ticket before dispatching, using the resolved project rootPath', async () => {
    const cache = createFakeBoardCache();
    const rootPath = '/projects/claim-order';
    seedOpenTicket(cache, 'bdboard-claim-order', rootPath);

    const callOrder: string[] = [];
    const issueWriter = makeIssueWriter({
      claim: vi.fn(async () => {
        callOrder.push('claim');
      }),
    });

    const dispatch = vi.fn(async (): Promise<RunOutcome> => {
      callOrder.push('dispatch');
      return {
        ok: true,
        run: {
          id: 'ignored',
          ticketId: 'bdboard-claim-order',
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
        worktreePath: managedWorktreePath('bdboard-claim-order', rootPath),
        branchName: 'bd/bdboard-claim-order',
        reused: false,
      })),
    });

    const { app } = makeRoutes({ cache, registry, worktreeProvisioner, issueWriter });
    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-claim-order')),
      LOCAL_ENV,
    );

    expect(response.status).toBe(202);
    expect(issueWriter.claim).toHaveBeenCalledWith(rootPath, 'bdboard-claim-order');
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(callOrder).toEqual(['claim', 'dispatch']);
  });

  it('returns 409 with reason claim-failed and does not dispatch when claim fails', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-claim-fail');

    const issueWriter = makeIssueWriter({
      claim: vi.fn(async () => {
        throw new Error('issue already claimed by someone-else');
      }),
    });

    const dispatch = vi.fn();
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const runStore = createRunStore({ now: () => NOW });
    const { app } = makeRoutes({ cache, registry, runStore, issueWriter });

    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-claim-fail')),
      LOCAL_ENV,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'issue already claimed by someone-else',
      reason: 'claim-failed',
    });
    expect(dispatch).not.toHaveBeenCalled();
    const runs = runStore.list({ ticketId: 'bdboard-claim-fail' });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(issueWriter.unclaim).not.toHaveBeenCalled();
  });

  it('unclaims the ticket when the run fails before any runner actually dispatches (dispatch-disabled)', async () => {
    const cache = createFakeBoardCache();
    const rootPath = '/projects/claim-rollback';
    seedOpenTicket(cache, 'bdboard-prespawn', rootPath);

    const issueWriter = makeIssueWriter();
    // No runner registered at all -> dispatchRun resolves with failureKind
    // 'unsupported', which is a pre-spawn failure (no runner.dispatch ever ran).
    const registry = createAgentRunnerRegistry();

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: managedWorktreePath('bdboard-prespawn', rootPath),
        branchName: 'bd/bdboard-prespawn',
        reused: false,
      })),
    });

    const runStore = createRunStore({ now: () => NOW });
    const { app } = makeRoutes({ cache, registry, runStore, worktreeProvisioner, issueWriter });

    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-prespawn')),
      LOCAL_ENV,
    );
    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      const runs = runStore.list({ ticketId: 'bdboard-prespawn' });
      expect(runs[0]?.status).toBe('failed');
    });

    expect(issueWriter.unclaim).toHaveBeenCalledWith(rootPath, 'bdboard-prespawn');
    const runs = runStore.list({ ticketId: 'bdboard-prespawn' });
    // buildUnsupportedOutcome (dispatch-run.ts) has no runner and never calls
    // runner.dispatch(); this is exactly the pre-spawn case the rollback targets.
    expect(runs[0]?.status).toBe('failed');
  });

  it('does not unclaim when the runner actually dispatched and then failed (failureKind failed)', async () => {
    const cache = createFakeBoardCache();
    const rootPath = '/projects/claim-no-rollback';
    seedOpenTicket(cache, 'bdboard-ran-then-failed', rootPath);

    const issueWriter = makeIssueWriter();
    const dispatch = vi.fn(async (): Promise<RunOutcome> => ({
      ok: false,
      failureKind: 'failed',
      error: 'claude exited with code 1',
      run: {
        id: 'ignored',
        ticketId: 'bdboard-ran-then-failed',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'failed',
        startedAt: NOW,
        finishedAt: NOW,
      },
    }));
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: managedWorktreePath('bdboard-ran-then-failed', rootPath),
        branchName: 'bd/bdboard-ran-then-failed',
        reused: false,
      })),
    });

    const runStore = createRunStore({ now: () => NOW });
    const { app } = makeRoutes({ cache, registry, runStore, worktreeProvisioner, issueWriter });

    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-ran-then-failed')),
      LOCAL_ENV,
    );
    expect(response.status).toBe(202);

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    // Let the fire-and-forget .then() chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issueWriter.unclaim).not.toHaveBeenCalled();
  });

  it('does not unclaim when the run succeeds', async () => {
    const cache = createFakeBoardCache();
    const rootPath = '/projects/claim-success';
    seedOpenTicket(cache, 'bdboard-claim-success', rootPath);

    const issueWriter = makeIssueWriter();
    const dispatch = vi.fn(async (): Promise<RunOutcome> => ({
      ok: true,
      run: {
        id: 'ignored',
        ticketId: 'bdboard-claim-success',
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
        worktreePath: managedWorktreePath('bdboard-claim-success', rootPath),
        branchName: 'bd/bdboard-claim-success',
        reused: false,
      })),
    });

    const { app } = makeRoutes({ cache, registry, worktreeProvisioner, issueWriter });
    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-claim-success')),
      LOCAL_ENV,
    );
    expect(response.status).toBe(202);

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issueWriter.unclaim).not.toHaveBeenCalled();
  });

  it('does not unclaim when the outcome is ok:false with no failureKind (unknown, treated as not-provably-pre-spawn)', async () => {
    const cache = createFakeBoardCache();
    const rootPath = '/projects/claim-unknown-failure-kind';
    seedOpenTicket(cache, 'bdboard-unknown-kind', rootPath);

    const issueWriter = makeIssueWriter();
    // Hypothetical/future runner misbehavior: ok:false with no failureKind at
    // all. isPreSpawnFailure treats this as "unknown, might have started" and
    // must not roll back the claim (opus review, bdboard-pkr6.26 PR #502).
    const dispatch = vi.fn(async (): Promise<RunOutcome> => ({
      ok: false,
      run: {
        id: 'ignored',
        ticketId: 'bdboard-unknown-kind',
        runner: 'claude-spawn',
        mode: 'spawn',
        status: 'failed',
        startedAt: NOW,
        finishedAt: NOW,
      },
    }));
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: managedWorktreePath('bdboard-unknown-kind', rootPath),
        branchName: 'bd/bdboard-unknown-kind',
        reused: false,
      })),
    });

    const runStore = createRunStore({ now: () => NOW });
    const { app } = makeRoutes({ cache, registry, runStore, worktreeProvisioner, issueWriter });

    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-unknown-kind')),
      LOCAL_ENV,
    );
    expect(response.status).toBe(202);

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issueWriter.unclaim).not.toHaveBeenCalled();
  });

  it('unclaims when dispatchRun rejects before any runner is dispatched (e.g. registry.resolve throws)', async () => {
    const cache = createFakeBoardCache();
    const rootPath = '/projects/claim-registry-throw';
    seedOpenTicket(cache, 'bdboard-registry-throw', rootPath);

    const issueWriter = makeIssueWriter();
    const explodingRegistry = {
      register: vi.fn(),
      resolve: vi.fn(() => {
        throw new Error('registry exploded');
      }),
      list: vi.fn(() => []),
    };

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: managedWorktreePath('bdboard-registry-throw', rootPath),
        branchName: 'bd/bdboard-registry-throw',
        reused: false,
      })),
    });

    const runStore = createRunStore({ now: () => NOW });
    const { app } = makeRoutes({
      cache,
      registry: explodingRegistry,
      runStore,
      worktreeProvisioner,
      issueWriter,
    });

    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-registry-throw')),
      LOCAL_ENV,
    );
    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      const runs = runStore.list({ ticketId: 'bdboard-registry-throw' });
      expect(runs[0]?.status).toBe('failed');
    });

    expect(issueWriter.unclaim).toHaveBeenCalledWith(rootPath, 'bdboard-registry-throw');
  });

  it('does not fail the run when unclaim itself fails after a pre-spawn failure (best-effort rollback)', async () => {
    const cache = createFakeBoardCache();
    const rootPath = '/projects/claim-unclaim-fails';
    seedOpenTicket(cache, 'bdboard-unclaim-fails', rootPath);

    const issueWriter = makeIssueWriter({
      unclaim: vi.fn(async () => {
        throw new Error('unclaim exploded');
      }),
    });
    const registry = createAgentRunnerRegistry();

    const worktreeProvisioner = makeProvisioner({
      provision: vi.fn(async () => ({
        ok: true as const,
        worktreePath: managedWorktreePath('bdboard-unclaim-fails', rootPath),
        branchName: 'bd/bdboard-unclaim-fails',
        reused: false,
      })),
    });

    const runStore = createRunStore({ now: () => NOW });
    const { app } = makeRoutes({ cache, registry, runStore, worktreeProvisioner, issueWriter });

    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-unclaim-fails')),
      LOCAL_ENV,
    );
    expect(response.status).toBe(202);

    await vi.waitFor(() => {
      const runs = runStore.list({ ticketId: 'bdboard-unclaim-fails' });
      expect(runs[0]?.status).toBe('failed');
    });

    expect(issueWriter.unclaim).toHaveBeenCalledWith(rootPath, 'bdboard-unclaim-fails');
    // The run's recorded outcome reflects the original dispatch failure, not the
    // secondary unclaim failure -- rollback is best-effort and must not mask it.
    const runs = runStore.list({ ticketId: 'bdboard-unclaim-fails' });
    expect(runs[0]?.status).toBe('failed');
  });
});

describe('createAgentRunRoutes harness preflight', () => {
  async function postRun(
    getHarnessStatus: () => Promise<ProjectHarnessStatus>,
    ticketId = 'bdboard-pre',
  ) {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, ticketId);
    const dispatch = vi.fn();
    const registry = createAgentRunnerRegistry();
    registry.register(makeRunner(dispatch));
    const worktreeProvisioner = makeProvisioner();
    const runStore = createRunStore({ now: () => NOW });

    const { app } = makeRoutes({
      cache,
      registry,
      runStore,
      worktreeProvisioner,
      getHarnessStatus,
    });
    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit(ticketId)),
      LOCAL_ENV,
    );

    return { response, dispatch, worktreeProvisioner, runStore, ticketId };
  }

  it('returns 409 harness-not-injected and provisions nothing', async () => {
    const { response, dispatch, worktreeProvisioner, runStore } = await postRun(
      async () => ({ packs: [], contract: { state: 'not-applicable' } }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.reason).toBe('harness-not-injected');
    expect(typeof body.detail).toBe('string');
    expect(worktreeProvisioner.provision).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    // 前提不足は実行スロットも履歴も消費しない。
    expect(runStore.list()).toHaveLength(0);
  });

  it('returns 409 harness-hooks-missing with the unregistered hook commands', async () => {
    const { response, worktreeProvisioner } = await postRun(async () =>
      readyHarnessStatus({
        hooksState: 'missing',
        missingHooks: ['bash .claude/hooks/bd-pre-bash-guard.sh'],
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: 'harness-hooks-missing',
      missingHooks: ['bash .claude/hooks/bd-pre-bash-guard.sh'],
    });
    expect(worktreeProvisioner.provision).not.toHaveBeenCalled();
  });

  it('returns 409 harness-contract-missing when the contract file is absent', async () => {
    const { response, worktreeProvisioner } = await postRun(async () =>
      readyHarnessStatus({}, { state: 'missing' }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      reason: 'harness-contract-missing',
    });
    expect(worktreeProvisioner.provision).not.toHaveBeenCalled();
  });

  it('starts the run with a drift warning instead of blocking', async () => {
    const { response, worktreeProvisioner } = await postRun(async () =>
      readyHarnessStatus({
        installedVersion: '0.9.0',
        availableVersion: '1.0.0',
        drift: true,
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'pending',
      warnings: ['harness-drift'],
    });
    expect(worktreeProvisioner.provision).toHaveBeenCalledTimes(1);
  });

  it('passes the contract mainBranch to the worktree provisioner (bdboard-pkr6.18)', async () => {
    const masterContract: ContractState = {
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'master',
      models: null,
      expiredExcludeCount: 0,
      modelExclusionWarnings: [],
    };
    const { response, worktreeProvisioner } = await postRun(async () =>
      readyHarnessStatus({}, masterContract),
    );

    expect(response.status).toBe(202);
    expect(worktreeProvisioner.provision).toHaveBeenCalledWith(
      expect.objectContaining({ mainBranch: 'master' }),
    );
  });

  it('passes the default contract mainBranch main through to provision', async () => {
    const { response, worktreeProvisioner } = await postRun(async () => readyHarnessStatus());

    expect(response.status).toBe(202);
    expect(worktreeProvisioner.provision).toHaveBeenCalledWith(
      expect.objectContaining({ mainBranch: 'main' }),
    );
  });

  it('returns an empty warnings array on a clean preflight', async () => {
    const { response } = await postRun(async () => readyHarnessStatus());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ warnings: [] });
  });

  it('passes the contract verify command into the run prompt', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-prompt');

    let resolveDispatch!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    let dispatchedPrompt = '';
    const dispatch = vi.fn(async (request: { prompt?: string }): Promise<RunOutcome> => {
      dispatchedPrompt = request.prompt ?? '';
      resolveDispatch();
      return {
        ok: true,
        run: {
          id: 'ignored',
          ticketId: 'bdboard-prompt',
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

    const { app } = makeRoutes({
      cache,
      registry,
      getHarnessStatus: async () =>
        readyHarnessStatus({}, {
          state: 'ok',
          verify: 'npm run check',
          prFlow: 'direct',
          mainBranch: 'trunk',
          models: null,
          expiredExcludeCount: 0,
          modelExclusionWarnings: [],
        }),
    });
    const response = await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-prompt')),
      LOCAL_ENV,
    );
    expect(response.status).toBe(202);
    await dispatched;

    expect(dispatchedPrompt).toContain('npm run check');
    expect(dispatchedPrompt).toContain('run 内では実行できません');
  });

  it('returns 500 without provisioning when the harness status cannot be read', async () => {
    const { response, worktreeProvisioner, runStore } = await postRun(async () => {
      throw new Error('settings.json is unreadable');
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'harness preflight failed: settings.json is unreadable',
    });
    expect(worktreeProvisioner.provision).not.toHaveBeenCalled();
    expect(runStore.list()).toHaveLength(0);
  });

  it('reads the harness status from the repository root, not the worktree', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-root', '/projects/other-repo');
    const getHarnessStatus = vi.fn(async () => readyHarnessStatus());

    const { app } = makeRoutes({ cache, getHarnessStatus });
    await app.request(
      '/api/runs',
      withLocalHost(postRunsInit('bdboard-root')),
      LOCAL_ENV,
    );

    expect(getHarnessStatus).toHaveBeenCalledWith('/projects/other-repo');
  });
});
