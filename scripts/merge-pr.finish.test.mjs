// bdboard-4dqo: scripts/merge-pr.test.mjs から切り出した finish 系のテスト (finish の拒否・
// 着地後検証の失敗・SIGINT/SIGTERM による中断・bdboard-2hj4 の verifyingPid 記録)。
// 一時リポジトリと偽の gh / bd / npm の harness は merge-pr.test-harness.mjs で共有する。
// describe 名は切り出し前と同じ (テスト名の集合を変えないため)。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { VERIFYING_PID_MAX_AGE_MS } from './merge-pr.mjs';
import {
  advanceMain,
  auditText,
  env,
  git,
  head,
  landSquash,
  mainCheckout,
  pidAlive,
  posted,
  PR,
  readFake,
  registerTempRepoHooks,
  run,
  SCRIPT,
  setup,
  simulateMerge,
  stateFile,
  status,
  tmp,
  verified,
  waitUntil,
  work,
  writeFake,
} from './merge-pr.test-harness.mjs';

// 1 テストで node / git を十数回起こす。verify の並列実行中でも既定 5 秒で落ちないよう余裕を取る。
describe.skipIf(process.platform === 'win32')('merge-pr phases against a temp repo + fake gh/bd/npm', { timeout: 30_000 }, () => {
  registerTempRepoHooks();

  it('finish: an unmerged PR (merge refused / 409) just returns the slot', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(5);
    expect(finished.stderr).toContain('マージされていません');
    expect(readFake().slot.holder).toBeNull();
    expect(posted()).toEqual([]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('finish: a failing landed-verify records failure and holds the slot for the repair (§3.6)', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(finished.status).toBe(6);
    expect(finished.stderr).toContain('revert');
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'failure'],
    ]);
    expect(readFake().slot.holder).toBe(`demo-1 / main-broken ${landed.slice(0, 12)}`);
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
  });

  it('finish: refuses to start while the working tree is dirty and leaves the ledger pending-free', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    writeFileSync(path.join(work, 'feature.txt'), 'uncommitted\n');
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain('npm run merge-pr -- verify');
    expect(readFake().slot.holder).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('finish / verify refuse to detach the main checkout; only a linked PR worktree runs the landed verify', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], {}, mainCheckout);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain('PR の worktree');
    expect(readFake().slot.holder).toBeNull(); // 枠は検証より先に返している
    expect(posted()).toEqual([]);
    expect(verified()).toEqual([]);
    expect(git(mainCheckout, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(run(['verify', landed], {}, mainCheckout).status).toBe(1);
    expect(posted()).toEqual([]);
    // PR の worktree からなら手で検証して台帳に書ける。
    expect(run(['verify', landed]).status).toBe(0);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
  });

  it('finish keeps the pending status fresh while verify runs, so other gates wait instead of self-healing', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], { BDBOARD_MERGE_HEARTBEAT_MS: '100', FAKE_VERIFY_SLEEP_MS: '1500' });
    expect(finished.status).toBe(0);
    const states = posted()
      .filter(({ sha }) => sha === landed)
      .map(({ state }) => state);
    expect(states[0]).toBe('pending');
    expect(states.at(-1)).toBe('success');
    expect(states.filter((state) => state === 'pending').length).toBeGreaterThanOrEqual(3);
  });

  it('S2 finish: a landed tree that differs from the predicted one is reported; the landed verify still decides', () => {
    setup({ merge: { mode: 'S2' } });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash(git(work, ['rev-parse', `${head}^{tree}`]));
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('着地予定ツリー');
    expect(finished.stderr).toContain('違います');
    expect(auditText()).toMatch(/\tpredicted-tree\tpr=7\tid=demo-1\tmatch=false/);
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([
      [landed, 'pending'],
      [landed, 'success'],
    ]);
  });

  it('finish: refuses while the worktree has an untracked, non-ignored file (gitignored ones do not block)', () => {
    setup({ branchFiles: { '.gitignore': 'ignored.log\n' } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    writeFileSync(path.join(work, 'ignored.log'), 'noise\n');
    writeFileSync(path.join(work, 'stray.ts'), 'export const x = 1;\n');
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(1);
    expect(finished.stderr).toContain('未追跡ファイル');
    expect(finished.stderr).toContain('stray.ts');
    expect(finished.stderr).not.toContain('ignored.log');
    expect(readFake().slot.holder).toBeNull(); // 枠は検証より先に返している
    expect(posted()).toEqual([]);
    expect(verified()).toEqual([]);
    expect(existsSync(stateFile())).toBe(true); // 記録は残る (finish をやり直せる)

    rmSync(path.join(work, 'stray.ts'));
    const retried = run(['finish', String(PR)]);
    expect(retried.status).toBe(0);
    expect(verified()).toEqual([landed]);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('finish: SIGINT during the landed verify kills the verify process and restores the branch instead of leaving an orphan / detached HEAD', async () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const pidFile = path.join(tmp, 'verify.pid');
    const startedAt = Date.now();
    const child = spawn(process.execPath, [SCRIPT, 'finish', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    try {
      // fake verify がまだ書き込み中の pid ファイルを読まないよう、パース結果が正の整数に
      // なるまで待つ (存在するだけでは不十分 — 書き込み途中の空/部分文字列を拾いうる)。
      await waitUntil(() => {
        if (!existsSync(pidFile)) {
          return false;
        }
        const parsed = Number(readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return false;
        }
        verifyPid = parsed;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);
      // bdboard-2hj4: 走っている finish は自分の pid の横に verifyingAt を刻み、その間に起動した
      // 2 本目の finish は二重に verify せず 75 で止まる。
      const stamped = JSON.parse(readFileSync(stateFile(), 'utf8'));
      expect(stamped.verifyingPid).toBe(child.pid);
      expect(Date.parse(stamped.verifyingAt)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(stamped.verifyingAt)).toBeLessThanOrEqual(Date.now());
      expect(run(['finish', String(PR)]).status).toBe(75);

      child.kill('SIGINT');
      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull(); // 自分で process.exit したので signal 経由の終了ではない
      expect(code).toBe(130); // SIGINT

      // 自然な sleep 終了 (60 秒) よりずっと短い窓で死んでいることを確かめる (kill が効いていない
      // 場合に「たまたま自然終了と重なって green になる」誤検出を避ける)。
      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 }); // 孤児にならず、確かに終わっている
    } finally {
      // アサーションが途中で失敗しても、子プロセスと (60 秒 sleep 中かもしれない) fake verify の
      // 孫プロセスを確実に後始末する。正常系ではどちらも既に死んでいるので kill は no-op になる。
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        try {
          process.kill(verifyPid, 'SIGKILL');
        } catch {
          // 確認と kill の間に終了していれば無視する。
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1'); // detach のまま残らない
    expect(posted().map((entry) => entry.state)).not.toContain('failure'); // 中断を failure と記録しない
    expect(stderr).toContain('SIGINT');
    expect(stderr).toContain('bd/demo-1');
    // bdboard-e8o1 (見送り分 3): 次にやり直すコマンドのヒントと、監査ログのイベント。
    expect(stderr).toContain(`そのまま次を実行してやり直せます: BDBOARD_MERGER=chair npm run merge-pr -- finish ${PR}`);
    expect(auditText()).toMatch(/\tlanded-verify-interrupted\tsha=[0-9a-f]{40}\tby=demo-1\tledger=true\tsignal=SIGINT/);
    // opus レビューで見つかった退行の固定化: 中断されたのに installAndVerify が呼び出し元へ
    // 制御を戻し、finish() の「検証を実行できなかった」エラーパスまで進んでしまわないこと。
    expect(stderr).not.toContain('着地後検証を実行できませんでした');

    // 状態・枠・台帳は壊れていないので、そのまま finish をやり直せる。
    const retried = run(['finish', String(PR)]);
    expect(retried.status).toBe(0);
    expect(existsSync(stateFile())).toBe(false);
  });

  it('finish: SIGTERM during the landed verify kills the verify process and restores the branch (same guarantee as SIGINT, different signal)', async () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const pidFile = path.join(tmp, 'verify-term.pid');
    const child = spawn(process.execPath, [SCRIPT, 'finish', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile, BDBOARD_MERGE_KILL_GRACE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    try {
      await waitUntil(() => {
        if (!existsSync(pidFile)) {
          return false;
        }
        const parsed = Number(readFileSync(pidFile, 'utf8').trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return false;
        }
        verifyPid = parsed;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);

      child.kill('SIGTERM');
      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull();
      expect(code).toBe(143); // SIGTERM

      await waitUntil(() => !pidAlive(verifyPid), { timeoutMs: 5_000 });
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      if (verifyPid !== undefined && pidAlive(verifyPid)) {
        try {
          process.kill(verifyPid, 'SIGKILL');
        } catch {
          // 確認と kill の間に終了していれば無視する。
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(posted().map((entry) => entry.state)).not.toContain('failure');
    expect(stderr).toContain('SIGTERM');
    expect(auditText()).toMatch(/\tlanded-verify-interrupted\tsha=[0-9a-f]{40}\tby=demo-1\tledger=true\tsignal=SIGTERM/);
    expect(stderr).not.toContain('着地後検証を実行できませんでした');

    const retried = run(['finish', String(PR)]);
    expect(retried.status).toBe(0);
  });

  it('finish: SIGINT also kills a grandchild the verify process spawns, not just the direct npm/shell child (pgid polling, 見送り分 1)', async () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const pidFile = path.join(tmp, 'verify-gc.pid');
    const grandchildPidFile = path.join(tmp, 'verify-gc-grandchild.pid');
    const child = spawn(process.execPath, [SCRIPT, 'finish', String(PR)], {
      cwd: work,
      env: {
        ...env,
        FAKE_VERIFY_SLEEP_MS: '60000',
        FAKE_VERIFY_PID_FILE: pidFile,
        FAKE_VERIFY_GRANDCHILD_PID_FILE: grandchildPidFile,
        BDBOARD_MERGE_KILL_GRACE_MS: '200',
        BDBOARD_MERGE_KILL_POLL_MS: '50',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let verifyPid;
    let grandchildPid;
    try {
      await waitUntil(() => {
        if (!existsSync(pidFile) || !existsSync(grandchildPidFile)) {
          return false;
        }
        const v = Number(readFileSync(pidFile, 'utf8').trim());
        const g = Number(readFileSync(grandchildPidFile, 'utf8').trim());
        if (!Number.isInteger(v) || v <= 0 || !Number.isInteger(g) || g <= 0) {
          return false;
        }
        verifyPid = v;
        grandchildPid = g;
        return true;
      });
      expect(pidAlive(verifyPid)).toBe(true);
      expect(pidAlive(grandchildPid)).toBe(true);
      expect(verifyPid).not.toBe(grandchildPid);

      child.kill('SIGINT');
      // 孫は SIGTERM を無視するので、後始末 (SIGKILL への昇格 → プロセスグループが実際に
      // 空になるまでのポーリング → restoreBranch) には少なくとも killGraceMs (200ms) かかる。
      // SIGINT 直後 (t=0) ではどちらの実装でもまだ何も起きていないので区別できない — 100ms
      // 待ってから確認する: これは旧実装 (return 'error' で finally の restoreBranch が
      // 同期区間ですぐ走る。孫の SIGKILL 猶予 200ms よりずっと早く完了する) なら既にブランチが
      // 戻ってしまっているはずの時点で、新実装 (孫がまだ生きているので後始末が完了していない)
      // なら detach したままのはずの時点 — opus レビューで見つかった退行の固定化。
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pidAlive(grandchildPid)).toBe(true);
      // symbolic-ref は detached HEAD だと非ゼロ終了で失敗する (git() ヘルパーが throw する) ので
      // rev-parse --abbrev-ref を使う (detached なら文字列 'HEAD' を返す。throw しない)。
      expect(git(work, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');

      const [code, signal] = await new Promise((resolve) => {
        child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      });
      expect(signal).toBeNull();
      expect(code).toBe(130);

      // グループ全体が本当に空になるまでポーリングで待つ (孫が生き残っていないか)。
      await waitUntil(() => !pidAlive(verifyPid) && !pidAlive(grandchildPid), { timeoutMs: 5_000 });
    } finally {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      for (const pid of [verifyPid, grandchildPid]) {
        if (pid !== undefined && pidAlive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // 確認と kill の間に終了していれば無視する。
          }
        }
      }
    }
    expect(git(work, ['symbolic-ref', '--short', 'HEAD'])).toBe('bd/demo-1');
    expect(posted().map((entry) => entry.state)).not.toContain('failure');
    expect(stderr).not.toContain('着地後検証を実行できませんでした');
  });

  // bdboard-2hj4: finish が状態ファイルに書く verifyingPid は、finish の中断・クラッシュで残る。その PID が
  // 後で別プロセスに再利用された (EPERM でも alive 扱い) 場合に、永久に RETRY (75) になってはいけない。
  describe('finish: a leftover verifyingPid record (bdboard-2hj4)', () => {
    const ago = (ms) => new Date(Date.now() - ms).toISOString();

    /** gate まで進めて PR をマージ済みにし、状態ファイルに verifyingPid (= 生きているこのテストの pid) を書く。 */
    function gatedAndMergedWithVerifying(extra) {
      setup();
      expect(run(['prepare', String(PR)]).status).toBe(0);
      expect(run(['gate', String(PR)]).status).toBe(0);
      const landed = simulateMerge();
      const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
      writeFileSync(stateFile(), `${JSON.stringify({ ...state, verifyingPid: process.pid, ...extra }, null, 2)}\n`);
      return landed;
    }

    it('a live pid with a day-old verifyingAt is a stale record: ignored with a notice, and the landed verify runs', () => {
      const landed = gatedAndMergedWithVerifying({ verifyingAt: ago(24 * 60 * 60_000) });
      const finished = run(['finish', String(PR)]);
      expect(finished.stderr).toContain(`verifyingPid ${process.pid}`);
      expect(finished.stderr).toContain('古い記録');
      expect(finished.status).toBe(0);
      expect(verified()).toEqual([landed]);
      expect(existsSync(stateFile())).toBe(false);
    });

    it('a live pid with a verifyingAt of right now still means a verify is running: 75, nothing touched', () => {
      gatedAndMergedWithVerifying({ verifyingAt: ago(0) });
      const finished = run(['finish', String(PR)]);
      expect(finished.status).toBe(75);
      expect(finished.stderr).toContain('二重に走らせません');
      expect(finished.stderr).toMatch(/あと (119|120) 分で古い記録として扱います/);
      expect(finished.stderr).toContain(`ps -p ${process.pid} -o lstart=,command=`);
      expect(finished.stderr).not.toContain('古い記録とみなして無視');
      expect(verified()).toEqual([]);
      expect(posted()).toEqual([]);
      expect(readFake().slot.holder).toBe(`demo-1 / PR#${PR}`); // 二重に動かないので枠もまだ返さない
      expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toMatchObject({ verifyingPid: process.pid });
    });

    it('the cut-off is VERIFYING_PID_MAX_AGE_MS: just inside it is still running, just outside it is stale', () => {
      gatedAndMergedWithVerifying({ verifyingAt: ago(VERIFYING_PID_MAX_AGE_MS - 60_000) });
      expect(run(['finish', String(PR)]).status).toBe(75);
      const landed = gatedAndMergedWithVerifying({ verifyingAt: ago(VERIFYING_PID_MAX_AGE_MS + 60_000) });
      expect(run(['finish', String(PR)]).status).toBe(0);
      expect(verified()).toEqual([landed]);
    });

    it('a record from before verifyingAt existed (or an unreadable verifyingAt) is judged by the pid alone, as before', () => {
      gatedAndMergedWithVerifying({});
      const legacy = run(['finish', String(PR)]);
      expect(legacy.status).toBe(75);
      expect(legacy.stderr).toContain('二重に走らせません');
      expect(legacy.stderr).toContain('旧形式');
      gatedAndMergedWithVerifying({ verifyingAt: 'not-a-date' });
      expect(run(['finish', String(PR)]).status).toBe(75);
      expect(verified()).toEqual([]);
    });
  });
});
