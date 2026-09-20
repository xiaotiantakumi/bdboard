// bdboard-sso1.36: agent-run-routes.test.ts (2315行) を #576 の agent-run ルート分割
// (create/read/cancel) に追随して move only 分割したうちの GET /api/runs 系。
// テスト本体は一字一句変更していない。変更したのは import と、元の
// describe('createAgentRunRoutes') から GET /api/runs (一覧・詳細) の it だけを
// 抽出して包んだ describe('GET /api/runs') の入れ物のみ。next step 系の describe
// (bdboard-pkr6.18) は元のタイトルのまま移動した。共有ヘルパーは
// agent-run-routes-test-support.ts へ移した。
import { describe, expect, it } from 'vitest';
import { createRunStore } from '../../application/runner/run-store.js';
import {
  NOW,
  LOCAL_ENV,
  withLocalHost,
  withRemoteTunnel,
  managedWorktreePath,
  createFakeBoardCache,
  allowingWriteAccess,
  readyHarnessStatus,
  makeRoutes,
  seedOpenTicket,
} from './agent-run-routes-test-support.js';

describe('GET /api/runs', () => {
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
});

describe('createAgentRunRoutes next step', () => {
  function finishedRunStore(
    ticketId: string,
    cwd: string,
    status: 'succeeded' | 'failed' = 'succeeded',
  ) {
    const runStore = createRunStore({ now: () => NOW });
    runStore.start({
      id: 'run-done',
      ticketId,
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd,
      startedAt: NOW,
    });
    runStore.finish('run-done', {
      ok: status === 'succeeded',
      run: {
        id: 'run-done',
        ticketId,
        runner: 'claude-spawn',
        mode: 'spawn',
        status,
        startedAt: NOW,
        finishedAt: NOW,
      },
    });
    return runStore;
  }

  it('returns the verify command and worktree path for a finished run', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-next');
    const worktreePath = managedWorktreePath('bdboard-next');
    const runStore = finishedRunStore('bdboard-next', worktreePath);

    const { app } = makeRoutes({ cache, runStore });
    const response = await app.request(
      '/api/runs/run-done',
      withLocalHost(),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      nextStep: { verify: 'npm run verify', worktreePath },
    });
  });

  it('omits nextStep while the run is still in progress', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-running');
    const runStore = createRunStore({ now: () => NOW });
    runStore.start({
      id: 'run-live',
      ticketId: 'bdboard-running',
      runner: 'claude-spawn',
      mode: 'spawn',
      cwd: managedWorktreePath('bdboard-running'),
      startedAt: NOW,
    });

    const { app } = makeRoutes({ cache, runStore });
    const response = await app.request(
      '/api/runs/run-live',
      withLocalHost(),
      LOCAL_ENV,
    );

    expect(await response.json()).not.toHaveProperty('nextStep');
  });

  it('omits nextStep when the contract is no longer satisfied', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-nocontract');
    const runStore = finishedRunStore(
      'bdboard-nocontract',
      managedWorktreePath('bdboard-nocontract'),
    );

    const { app } = makeRoutes({
      cache,
      runStore,
      getHarnessStatus: async () => readyHarnessStatus({}, { state: 'missing' }),
    });
    const response = await app.request(
      '/api/runs/run-done',
      withLocalHost(),
      LOCAL_ENV,
    );

    expect(await response.json()).not.toHaveProperty('nextStep');
  });

  // 失敗/中断した run で検証を促すのは誤った導線 (編集が中断・破棄されている
  // 可能性がある)。出すのは succeeded のときだけ。
  it('omits nextStep for a failed run', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-failed');
    const runStore = finishedRunStore(
      'bdboard-failed',
      managedWorktreePath('bdboard-failed'),
      'failed',
    );

    const { app } = makeRoutes({ cache, runStore });
    const response = await app.request(
      '/api/runs/run-done',
      withLocalHost(),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'failed' });
    expect(body).not.toHaveProperty('nextStep');
  });

  it('does not expose nextStep to remote clients', async () => {
    const cache = createFakeBoardCache();
    seedOpenTicket(cache, 'bdboard-remote');
    const runStore = finishedRunStore(
      'bdboard-remote',
      managedWorktreePath('bdboard-remote'),
    );

    const { app } = makeRoutes({
      cache,
      runStore,
      writeAccess: allowingWriteAccess(),
    });
    const response = await app.request(
      '/api/runs/run-done',
      withRemoteTunnel(),
      LOCAL_ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('nextStep');
  });
});
