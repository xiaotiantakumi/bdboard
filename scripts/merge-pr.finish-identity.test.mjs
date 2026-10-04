// bdboard-ky9l: finish が状態ファイルに残す verifyingPid / verifyPgid の記録を、プロセスの開始時刻で
// 「記録したのと同じプロセスか」まで確かめる (PID 再利用・2 時間超の正規の実行・SIGKILL された finish が
// 残す孤児の verify プロセスグループ)。一時リポジトリと偽の gh / bd / npm の harness は
// merge-pr.test-support.mjs で共有する。判定表そのものの単体テストは merge-pr.verifying-record.test.mjs。
//
// 開始時刻は ps (POSIX) で取る。Windows は取らない (process-identity.mjs) ので、このファイルは win32 では
// 丸ごと skip する (merge-pr 本体の統合テストと同じ)。ps が無い環境でも skip する。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compareStartTime, isProcessGroupAlive, processStartTime } from './process-identity.mjs';
import {
  env,
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
  tmp,
  verified,
  waitUntil,
  work,
} from './merge-pr.test-support.mjs';

const hasPs = processStartTime(process.pid) !== null;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const readStateFile = () => JSON.parse(readFileSync(stateFile(), 'utf8'));
// 書き込み途中の状態ファイルを読んでも落ちない版 (waitUntil のポーリング用)。
const tryReadStateFile = () => {
  try {
    return readStateFile();
  } catch {
    return null;
  }
};
const A_DIFFERENT_START = '2000-01-01T00:00:00.000Z';

/** gate まで進めて PR をマージ済みにし、状態ファイルに extra を足す。着地した SHA を返す。 */
function gatedAndMerged(extra) {
  setup();
  expect(run(['prepare', String(PR)]).status).toBe(0);
  expect(run(['gate', String(PR)]).status).toBe(0);
  const landed = simulateMerge();
  writeFileSync(stateFile(), `${JSON.stringify({ ...readStateFile(), ...extra }, null, 2)}\n`);
  return landed;
}

/** 新しいセッション・プロセスグループのリーダー (= pgid が自分の pid) として、60 秒眠るだけの node を起こす。 */
const spawnGroupLeader = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });

/**
 * リーダーの居ないプロセスグループを作り、その pgid を返す。sh がバックグラウンドで sleep を残して終わる:
 * pgid (= sh の pid) のリーダーは居ないが、グループには sleep が居る。終わらせるのは killGroupQuietly(pgid)。
 */
async function spawnLeaderlessGroup() {
  const shell = spawn('sh', ['-c', 'sleep 60 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  shell.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  const exited = new Promise((resolve) => shell.once('exit', resolve));
  await exited;
  await waitUntil(() => stdout.trim() !== '');
  return shell.pid;
}

function killGroupQuietly(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // もう居なければ無視する。
  }
}

// 1 テストで node / git を十数回起こす (最後のテストは setup + finish を 2 回ずつ)。verify の並列実行中でも
// 落ちないよう、merge-pr.finish.test.mjs の 30 秒より広く取る。
describe.skipIf(process.platform === 'win32' || !hasPs)('merge-pr finish: process identity of the verify records (bdboard-ky9l)', { timeout: 60_000 }, () => {
  registerTempRepoHooks();

  describe('verifyingPid', () => {
    it('a live pid whose start time differs from the recorded one is a reused pid: finish proceeds even though the record is fresh', () => {
      const landed = gatedAndMerged({ verifyingPid: process.pid, verifyingAt: ago(0), verifyingStart: A_DIFFERENT_START });
      const finished = run(['finish', String(PR)]);
      expect(finished.stderr).toContain(`verifyingPid ${process.pid}`);
      expect(finished.stderr).toContain('別のプロセス');
      expect(finished.stderr).toContain('PID が再利用された');
      expect(finished.status).toBe(0);
      expect(verified()).toEqual([landed]);
      expect(existsSync(stateFile())).toBe(false);
    });

    it('the same process more than 2 hours later is still running: 75, nothing touched (a long verify, or a machine that slept)', () => {
      gatedAndMerged({ verifyingPid: process.pid, verifyingAt: ago(3 * 60 * 60_000), verifyingStart: processStartTime(process.pid) });
      const finished = run(['finish', String(PR)]);
      expect(finished.status).toBe(75);
      expect(finished.stderr).toContain('二重に走らせません');
      expect(finished.stderr).toContain('同一なので、何時間経っていても古い記録とはみなしません');
      expect(finished.stderr).not.toContain('古い記録とみなして無視');
      expect(verified()).toEqual([]);
      expect(posted()).toEqual([]);
      expect(readFake().slot.holder).toBe(`demo-1 / PR#${PR}`); // 二重に動かないので枠もまだ返さない
      expect(readStateFile()).toMatchObject({ verifyingPid: process.pid });
    });

    it('a start time that differs by the 1-second drift of ps still counts as the same process', () => {
      const drifted = new Date(Date.parse(processStartTime(process.pid)) + 1_000).toISOString();
      gatedAndMerged({ verifyingPid: process.pid, verifyingAt: ago(3 * 60 * 60_000), verifyingStart: drifted });
      expect(run(['finish', String(PR)]).status).toBe(75);
      expect(verified()).toEqual([]);
    });
  });

  describe('verifyPgid: a verify process group left behind by a finish that was killed', () => {
    it('finish stamps its own start time and the verify group; a SIGKILLed finish leaves the group alive, and the rerun starts no second verify (75)', async () => {
      setup();
      expect(run(['prepare', String(PR)]).status).toBe(0);
      expect(run(['gate', String(PR)]).status).toBe(0);
      const landed = simulateMerge();
      const pidFile = path.join(tmp, 'orphan-verify.pid');
      const startedAt = Date.now();
      const child = spawn(process.execPath, [SCRIPT, 'finish', String(PR)], {
        cwd: work,
        env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile },
        stdio: 'ignore',
      });
      let pgid;
      try {
        // verifyPgid を書いてから ps で取った verifyPgidStart を足す 2 回目の書き込みまで待つ。
        await waitUntil(() => {
          const state = tryReadStateFile();
          pgid = state?.verifyPgid;
          return Number.isInteger(pgid) && typeof state.verifyPgidStart === 'string' && existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '';
        });
        const stamped = readStateFile();
        expect(stamped.verifyingPid).toBe(child.pid);
        expect(Date.parse(stamped.verifyingAt)).toBeGreaterThanOrEqual(startedAt);
        expect(compareStartTime(child.pid, stamped.verifyingStart)).toBe('same'); // finish 自身の開始時刻
        expect(pgid).not.toBe(child.pid); // verify は finish とは別のプロセスグループ (detached)
        expect(compareStartTime(pgid, stamped.verifyPgidStart)).toBe('same'); // verify のリーダーの開始時刻
        expect(Date.parse(stamped.verifyPgidAt)).toBeGreaterThanOrEqual(Date.parse(stamped.verifyingAt));
        expect(isProcessGroupAlive(pgid)).toBe(true);
        expect(verified()).toEqual([landed]);

        // 二重起動の窓: 生きている finish が居る間は、PID の同一性で 75 になる (bdboard-2hj4 と同じ)。
        expect(run(['finish', String(PR)]).status).toBe(75);

        // finish が SIGKILL された: 後始末が走らないので、detached の verify のグループは孤児として残る。
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
        expect(pidAlive(child.pid)).toBe(false);
        expect(isProcessGroupAlive(pgid)).toBe(true);

        const rerun = run(['finish', String(PR)]);
        expect(rerun.status).toBe(75);
        expect(rerun.stderr).toContain(`verify のプロセスグループ ${pgid}`);
        expect(rerun.stderr).toContain('二重に走らせません');
        expect(rerun.stderr).toContain(`kill -TERM -${pgid}`);
        expect(verified()).toEqual([landed]); // 2 本目の verify は起動していない
        expect(posted().map((entry) => entry.state)).not.toContain('success'); // 2 本目が走っていれば、ここで台帳に結果が載る
        expect(posted().map((entry) => entry.state)).not.toContain('failure');
        expect(readStateFile()).toMatchObject({ verifyPgid: pgid }); // 記録はそのまま残る

        // 孤児を畳めば、再実行は進む。
        killGroupQuietly(pgid);
        await waitUntil(() => !isProcessGroupAlive(pgid), { timeoutMs: 5_000 });
        const retried = run(['finish', String(PR)]);
        expect(retried.status).toBe(0);
        expect(verified()).toEqual([landed, landed]);
        expect(existsSync(stateFile())).toBe(false);
      } finally {
        child.kill('SIGKILL');
        if (Number.isInteger(pgid)) {
          killGroupQuietly(pgid);
        }
      }
    });

    it('a recorded group that is gone is not a reason to wait', () => {
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      const landed = gatedAndMerged({ verifyPgid: gone, verifyPgidAt: ago(0), verifyPgidStart: processStartTime(process.pid) });
      const finished = run(['finish', String(PR)]);
      expect(finished.status).toBe(0);
      expect(verified()).toEqual([landed]);
    });

    it('a live group leader that was started at the recorded time is the original verify: 75', () => {
      const leader = spawnGroupLeader();
      try {
        gatedAndMerged({ verifyPgid: leader.pid, verifyPgidAt: ago(3 * 60 * 60_000), verifyPgidStart: processStartTime(leader.pid) });
        const finished = run(['finish', String(PR)]);
        expect(finished.status).toBe(75);
        expect(finished.stderr).toContain(`verify のプロセスグループ ${leader.pid}`);
        expect(verified()).toEqual([]);
      } finally {
        killGroupQuietly(leader.pid);
      }
    });

    it('a live group leader started at another time is a reused pid: the record is ignored with a notice and finish proceeds', () => {
      const leader = spawnGroupLeader();
      try {
        const landed = gatedAndMerged({ verifyPgid: leader.pid, verifyPgidAt: ago(0), verifyPgidStart: A_DIFFERENT_START });
        const finished = run(['finish', String(PR)]);
        expect(finished.stderr).toContain(`verify プロセスグループ ${leader.pid} の記録は、別のプロセスに再利用された古い記録`);
        expect(finished.status).toBe(0);
        expect(verified()).toEqual([landed]);
      } finally {
        killGroupQuietly(leader.pid);
      }
    });

    it('a group whose leader has exited but still has a member is the original group while it is within the cap, whatever the start time says: 75', async () => {
      const pgid = await spawnLeaderlessGroup();
      try {
        expect(pidAlive(pgid)).toBe(false);
        expect(isProcessGroupAlive(pgid)).toBe(true);
        gatedAndMerged({ verifyPgid: pgid, verifyPgidAt: ago(60 * 60_000), verifyPgidStart: A_DIFFERENT_START });
        const finished = run(['finish', String(PR)]);
        expect(finished.status).toBe(75);
        expect(finished.stderr).toContain(`verify のプロセスグループ ${pgid}`);
        expect(finished.stderr).toContain('上限 120 分以内なので前回の verify の残りとみなして止めます'); // いつまで止まるかを言う
        expect(verified()).toEqual([]);
      } finally {
        killGroupQuietly(pgid);
      }
    });

    // bdboard-h2fk: verify は親が死ぬと自分で畳むので、リーダー不在のまま長く生きているグループは、番号を再利用した
    // 無関係の二重 fork デーモンの可能性が高い。元の verify とは言い切れないので「不明」にして、案内だけを出して進む。
    it('a leaderless group older than the cap is unknown: advice only, finish goes on (not 75 forever), and nothing is killed', async () => {
      const pgid = await spawnLeaderlessGroup();
      try {
        const landed = gatedAndMerged({ verifyPgid: pgid, verifyPgidAt: ago(3 * 60 * 60_000), verifyPgidStart: A_DIFFERENT_START });
        const finished = run(['finish', String(PR)]);
        expect(finished.status).toBe(0);
        expect(verified()).toEqual([landed]);
        expect(finished.stderr).not.toContain('二重に走らせません');
        expect(finished.stderr).toContain(`verify プロセスグループ ${pgid} は、リーダー (PID ${pgid}) が居ないままメンバーだけが残っていて`);
        expect(finished.stderr).toContain('上限 120 分を超えています');
        expect(finished.stderr).toContain('元の verify かは不明です');
        expect(finished.stderr).toContain('止めずに、着地後検証を進めます');
        // kill の案内は、中身を確かめる pgrep の後にだけ付く。確かめずに畳ませない。
        const check = finished.stderr.indexOf(`pgrep -g ${pgid} -l`);
        const kill = finished.stderr.indexOf(`kill -TERM -${pgid}`);
        expect(check).toBeGreaterThan(-1);
        expect(kill).toBeGreaterThan(check);
        expect(finished.stderr).toContain('確かめずに kill しない');
        expect(isProcessGroupAlive(pgid)).toBe(true); // 案内だけ: finish はグループに触れない
        expect(existsSync(stateFile())).toBe(false);
      } finally {
        killGroupQuietly(pgid);
      }
    });

    it('the cap is measured from verifyPgidAt: just inside it the same group still stops finish with 75', async () => {
      const pgid = await spawnLeaderlessGroup();
      try {
        gatedAndMerged({ verifyPgid: pgid, verifyPgidAt: ago(2 * 60 * 60_000 - 5 * 60_000), verifyPgidStart: A_DIFFERENT_START });
        const finished = run(['finish', String(PR)]);
        expect(finished.status).toBe(75);
        expect(finished.stderr).toContain('二重に走らせません');
        expect(finished.stderr).not.toContain('元の verify かは不明です');
        expect(verified()).toEqual([]);
      } finally {
        killGroupQuietly(pgid);
      }
    });
  });

  // PR #847 レビュー指摘 5: PID 再利用を検出したのに孤児グループが生きているとき、「古い記録を無視して進めます」と
  // 出してから 75 で止まっていた (文言と挙動の食い違い)。進むと決まってから通知を出し、止まるときは止まる理由を言う。
  describe('a reused verifyingPid together with a live verify group (bdboard-h2fk)', () => {
    it('stops with 75 and says so: the stale pid record is not announced as ignored-and-proceeding', () => {
      const leader = spawnGroupLeader();
      try {
        gatedAndMerged({
          verifyingPid: process.pid, // 開始時刻が違う = PID が再利用された記録
          verifyingAt: ago(0),
          verifyingStart: A_DIFFERENT_START,
          verifyPgid: leader.pid, // 元の verify のグループは生きている
          verifyPgidAt: ago(0),
          verifyPgidStart: processStartTime(leader.pid),
        });
        const finished = run(['finish', String(PR)]);
        expect(finished.status).toBe(75);
        expect(verified()).toEqual([]);
        expect(finished.stderr).toContain(`verify のプロセスグループ ${leader.pid}`);
        expect(finished.stderr).toContain('二重に走らせません');
        // 止まる理由として、PID の記録が古いことと、それでも進まないことを言う。
        expect(finished.stderr).toContain(`verifyingPid ${process.pid}`);
        expect(finished.stderr).toContain('PID が再利用された古い記録です');
        expect(finished.stderr).toContain('進まずここで止まります');
        // 「無視して進める」とは言わない (止まるのだから)。
        expect(finished.stderr).not.toContain('この記録は無視して、着地後検証を進めます');
        expect(finished.stderr).not.toContain('着地後検証を進めます');
      } finally {
        killGroupQuietly(leader.pid);
      }
    });

    it('proceeds and says so when the group is gone: the stale pid record is announced as ignored', () => {
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      const landed = gatedAndMerged({
        verifyingPid: process.pid,
        verifyingAt: ago(0),
        verifyingStart: A_DIFFERENT_START,
        verifyPgid: gone,
        verifyPgidAt: ago(0),
        verifyPgidStart: processStartTime(process.pid),
      });
      const finished = run(['finish', String(PR)]);
      expect(finished.status).toBe(0);
      expect(verified()).toEqual([landed]);
      expect(finished.stderr).toContain('この記録は無視して、着地後検証を進めます');
    });
  });

  it('a record written before the start-time fields existed behaves as it did: judged by the age alone', () => {
    // bdboard-2hj4 の形 (verifyingPid + verifyingAt だけ) の古い記録を読んで落ちない・挙動が変わらない。
    gatedAndMerged({ verifyingPid: process.pid, verifyingAt: ago(60_000) });
    expect(run(['finish', String(PR)]).status).toBe(75);
    const landed = gatedAndMerged({ verifyingPid: process.pid, verifyingAt: ago(24 * 60 * 60_000) });
    const finished = run(['finish', String(PR)]);
    expect(finished.status).toBe(0);
    expect(finished.stderr).toContain('上限');
    expect(verified()).toEqual([landed]);
  });
});
