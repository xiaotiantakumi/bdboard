// bdboard-wj9m: verify スロットの待ちが打ち切られたとき (verify.mjs の予約済み終了コード 75、
// scripts/verify-slot.mjs の SLOT_WAIT_TIMEOUT_EXIT_CODE) に、merge-pr の着地後検証が台帳 (commit
// status) へ failure を書かない — main は壊れていないのに main-broken と誤記録され、枠の保持
// (holdBrokenMain) にまで至るのを防ぐ — ことの確認。
// 偽の検証コマンドが FAKE_VERIFY_EXIT=75 で終わる = スロット待ちの打ち切りの代役。一時リポジトリと
// 偽の gh / bd / npm の harness は merge-pr.test-support.mjs と共有する (既存の大きな共有テストファイルには
// 足さず、別ファイルにしている — 並行チケットとの衝突を避けるため)。
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  advanceMain,
  auditText,
  calls,
  git,
  posted,
  PR,
  readFake,
  readState,
  registerTempRepoHooks,
  run,
  setup,
  simulateMerge,
  stateFile,
  verified,
  work,
  writeFake,
} from './merge-pr.test-support.mjs';

const SLOT_TIMEOUT = { FAKE_VERIFY_EXIT: '75' };

// 1 テストで node / git を十数回起こす。verify の並列実行中でも既定 5 秒で落ちないよう余裕を取る。
describe.skipIf(process.platform === 'win32')('merge-pr: a verify slot wait timeout is not a failed verify (bdboard-wj9m)', { timeout: 30_000 }, () => {
  registerTempRepoHooks();

  it('finish: records no failure (nor main-broken), keeps no slot, and says the verify did not run', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], SLOT_TIMEOUT);
    // 検証を実行できなかった = 'error' の経路 (EXIT.USAGE)。LANDED_FAILED (6) の「revert してください」ではない。
    expect(finished.status).toBe(1);
    expect(finished.status).not.toBe(6);
    expect(finished.stderr).toContain('verify スロットの待ちがタイムアウトしました');
    expect(finished.stderr).toContain('着地後検証を実行できませんでした');
    expect(finished.stderr).not.toContain('revert');
    // 書いたのは verify の直前の pending だけ。failure も error も書かない (error も main-broken と読まれる)。
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([[landed, 'pending']]);
    expect(readFake().slot.holder).toBeNull(); // holdBrokenMain に至っていない
    expect(auditText()).toMatch(/\tlanded-verify\t.*result=error/);
    expect(auditText()).not.toContain('main-broken');
    // 状態は残り (再試行できる)。二重起動の目印は bdboard-wea0.2 で worktree lock に置き換えて書かない。
    expect(existsSync(stateFile())).toBe(true);
    expect(readState()).toMatchObject({ newMain: landed });
    expect(readState()).not.toHaveProperty('verifyingPid');
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it('finish: after the timeout, running the verify again once the slot is free records success', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    expect(run(['finish', String(PR)], SLOT_TIMEOUT).status).toBe(1);
    const retried = run(['verify', landed]);
    expect(retried.status).toBe(0);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'pending'],
      [landed, 'success'],
    ]);
  });

  it('verify <sha>: records no failure for 75, but any other non-zero exit is still a failure', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const timedOut = run(['verify', landed], SLOT_TIMEOUT);
    expect(timedOut.status).toBe(1);
    expect(timedOut.stderr).toContain('verify スロットの待ちがタイムアウトしました');
    expect(posted().map(({ state }) => state)).toEqual(['pending']);
    // 対照: 75 の隣の値 (74・76) は、予約値ではないので従来どおり verify の失敗。
    for (const exit of ['74', '76']) {
      const failed = run(['verify', landed], { FAKE_VERIFY_EXIT: exit });
      expect(failed.status).toBe(6);
      expect(failed.stderr).toContain(`verify が失敗しました (exit ${exit})`);
    }
    expect(posted().map(({ state }) => state)).toEqual(['pending', 'pending', 'failure', 'pending', 'failure']);
  });

  it('gate: a self-heal verify that times out for a slot writes no failure and does not block the merge as main-broken', () => {
    setup({ mainDate: '2026-01-01T00:00:00Z' });
    writeFake({ statuses: {} }); // PRED_BASE の着地後検証が LEASE を過ぎても記録されていない = 自己修復の対象
    expect(run(['prepare', String(PR)]).status).toBe(0);
    const gated = run(['gate', String(PR)], SLOT_TIMEOUT);
    expect(gated.status).toBe(1); // 4 (MAIN_BROKEN) ではない
    expect(gated.stderr).toContain('自己修復の検証を実行できませんでした');
    expect(posted().map(({ state }) => state)).toEqual(['pending']);
    expect(calls('bd', 'acquire')).toEqual([]);
    expect(auditText()).not.toContain('gate-main-broken');
  });

  it('S2 prepare: a predicted-tree verify that times out for a slot is not a semantic conflict (no rebase demotion)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)], SLOT_TIMEOUT);
    expect(prepared.status).toBe(1); // 3 (NEEDS_REBASE) ではない
    expect(prepared.stderr).toContain('verify スロットの待ちがタイムアウトしました');
    expect(prepared.stderr).not.toContain('rebase に格下げ');
    expect(verified()).toHaveLength(1);
    expect(existsSync(stateFile())).toBe(false);
    expect(posted()).toEqual([]);
    expect(auditText()).toMatch(/\tpredicted-verify\t.*result=error/);
  });
});
