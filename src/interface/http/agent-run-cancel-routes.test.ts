// bdboard-sso1.36: agent-run-routes.test.ts (2315行) を #576 の agent-run ルート分割
// (create/read/cancel) に追随して move only 分割したうちの POST /api/runs/:runId/cancel
// 系。テスト本体は一字一句変更していない。変更したのは import と、元の
// describe('createAgentRunRoutes') から cancel の it だけを抽出して包んだ
// describe('POST /api/runs/:runId/cancel') の入れ物のみ。共有ヘルパーは
// agent-run-routes-test-support.ts へ移した。
import { describe, expect, it } from 'vitest';
import { createRunStore } from '../../application/runner/run-store.js';
import { NOW, LOCAL_ENV, withLocalHost, makeRoutes } from './agent-run-routes-test-support.js';

describe('POST /api/runs/:runId/cancel', () => {
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
});
