// bdboard-h2fk (PR #847 レビュー指摘 7): S2 prepare が起こす着地予定ツリーの verify は、finish の verify と同じく
// detached のプロセスグループで走る。prepare が SIGKILL されるとそのグループが孤児として残り、worktree は着地予定
// コミットで detach したままになる。再実行した prepare は孤児の生きている間は止まり (75)、2 本目の verify を起こさず、
// HEAD の detach を戻す案内 (assertLocalHead) より先に出る — その案内に従った git checkout が孤児の足元の木を
// 差し替えてしまうため。記録は scripts/merge-pr/predicted-guard.mjs が専用ファイルに残す。
//
// 実プロセス + 一時リポジトリ (merge-pr.test-support.mjs の偽の gh / bd / npm)。開始時刻は ps (POSIX) で取る
// ので、Windows と ps の無い環境では丸ごと skip する (merge-pr.finish-identity.test.mjs と同じ)。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compareStartTime, isProcessGroupAlive, processStartTime } from './process-identity.mjs';
import {
  advanceMain,
  env,
  git,
  head,
  mainCheckout,
  pidAlive,
  PR,
  registerTempRepoHooks,
  run,
  SCRIPT,
  setup,
  stateFile,
  tmp,
  verified,
  waitUntil,
  work,
} from './merge-pr.test-support.mjs';

const hasPs = processStartTime(process.pid) !== null;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const A_DIFFERENT_START = '2000-01-01T00:00:00.000Z';

const recordFile = () => path.join(mainCheckout, '.git', 'bdboard-merge', `pr-${PR}-predicted-verify.json`);
const tryReadRecord = () => {
  try {
    return JSON.parse(readFileSync(recordFile(), 'utf8'));
  } catch {
    return null; // 無い・書き込み途中
  }
};
const writeRecord = (record) => {
  mkdirSync(path.dirname(recordFile()), { recursive: true });
  writeFileSync(recordFile(), `${JSON.stringify({ pr: PR, ...record }, null, 2)}\n`);
};

/** リーダーの居ないプロセスグループを作り、その pgid を返す (sh が sleep を残して終わる)。畳むのは killGroupQuietly。 */
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

const spawnGroupLeader = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });

function killGroupQuietly(pgid) {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // もう居なければ無視する。
  }
}

/** S2 の準備: main を先へ進めて、PR をクラス F (着地予定ツリーの verify が走る) にする。 */
function setupClassF() {
  setup({ merge: { mode: 'S2' } });
  return advanceMain({ 'peer.txt': 'peer\n' });
}

// 1 テストで node / git を十数回起こす。verify の並列実行中でも落ちないよう広めに取る。
describe.skipIf(process.platform === 'win32' || !hasPs)('merge-pr prepare: an orphaned predicted verify (bdboard-h2fk)', { timeout: 60_000 }, () => {
  registerTempRepoHooks();

  it('a SIGKILLed prepare leaves its predicted verify; the rerun stops with 75 ahead of the detached-HEAD advice, starts no second verify, and goes on once the group is gone', async () => {
    setupClassF();
    const pidFile = path.join(tmp, 'predicted-verify.pid');
    const child = spawn(process.execPath, [SCRIPT, 'prepare', String(PR)], {
      cwd: work,
      env: { ...env, FAKE_VERIFY_SLEEP_MS: '60000', FAKE_VERIFY_PID_FILE: pidFile },
      stdio: 'ignore',
    });
    let pgid;
    try {
      // verifyPgid を書いてから ps で取った verifyPgidStart を足す 2 回目の書き込みまで待つ。
      await waitUntil(() => {
        const record = tryReadRecord();
        pgid = record?.verifyPgid;
        return Number.isInteger(pgid) && typeof record.verifyPgidStart === 'string' && existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '';
      });
      const record = tryReadRecord();
      expect(record.pr).toBe(PR);
      expect(compareStartTime(pgid, record.verifyPgidStart)).toBe('same'); // verify のリーダーの開始時刻
      expect(Date.parse(record.verifyPgidAt)).toBeGreaterThan(0);
      expect(existsSync(stateFile())).toBe(false); // prepare は検証の前に状態ファイルを消す。記録は専用ファイル
      expect(git(work, ['rev-parse', 'HEAD'])).not.toBe(head); // 着地予定コミットで detach している
      expect(verified()).toHaveLength(1);

      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL'); // 後始末が走らない: detached の verify のグループは孤児として残る
      await exited;
      expect(isProcessGroupAlive(pgid)).toBe(true);

      const rerun = run(['prepare', String(PR)]);
      expect(rerun.status).toBe(75);
      expect(rerun.stderr).toContain(`プロセスグループ ${pgid}`);
      expect(rerun.stderr).toContain('二重に走らせません');
      expect(rerun.stderr).toContain('git checkout で戻さないでください');
      expect(rerun.stderr).not.toContain('ローカル HEAD'); // assertLocalHead の「detach を戻して」の案内より先に止まる
      const check = rerun.stderr.indexOf(`pgrep -g ${pgid} -l`);
      const kill = rerun.stderr.indexOf(`kill -TERM -${pgid}`);
      expect(check).toBeGreaterThan(-1);
      expect(kill).toBeGreaterThan(check);
      expect(verified()).toHaveLength(1); // 2 本目の verify は起動していない
      expect(existsSync(stateFile())).toBe(false);
      expect(tryReadRecord()).toMatchObject({ verifyPgid: pgid }); // 記録はそのまま残る
      expect(isProcessGroupAlive(pgid)).toBe(true); // 止まるだけ: prepare はグループに触れない

      // 孤児を畳んで detach を戻せば、再実行は進む。
      killGroupQuietly(pgid);
      await waitUntil(() => !isProcessGroupAlive(pgid), { timeoutMs: 5_000 });
      git(work, ['checkout', '-q', 'bd/demo-1']);
      const retried = run(['prepare', String(PR)]);
      expect(retried.status).toBe(0);
      expect(verified()).toHaveLength(2);
      expect(existsSync(recordFile())).toBe(false); // 終わった verify の記録は消える
      expect(existsSync(stateFile())).toBe(true);
    } finally {
      child.kill('SIGKILL');
      if (Number.isInteger(pgid)) {
        killGroupQuietly(pgid);
      }
    }
  });

  it('a prepare that finishes leaves no record behind, whichever way the predicted verify ended', () => {
    setupClassF();
    const failed = run(['prepare', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(failed.status).toBe(3); // 着地予定ツリーの verify が failure → rebase に格下げ
    expect(verified()).toHaveLength(1);
    expect(existsSync(recordFile())).toBe(false);
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(verified()).toHaveLength(2);
    expect(existsSync(recordFile())).toBe(false);
  });

  describe('a record left behind', () => {
    it('a leaderless group within the cap is the original verify: 75, with the time it keeps stopping for', async () => {
      setupClassF();
      const pgid = await spawnLeaderlessGroup();
      try {
        writeRecord({ verifyPgid: pgid, verifyPgidAt: ago(60 * 60_000), verifyPgidStart: A_DIFFERENT_START });
        expect(pidAlive(pgid)).toBe(false);
        const prepared = run(['prepare', String(PR)]);
        expect(prepared.status).toBe(75);
        expect(prepared.stderr).toContain(`プロセスグループ ${pgid}`);
        expect(prepared.stderr).toContain('上限 120 分以内なので前回の verify の残りとみなして止めます');
        expect(verified()).toEqual([]);
      } finally {
        killGroupQuietly(pgid);
      }
    });

    it('a leaderless group older than the cap is unknown: advice only (pgrep before kill), prepare goes on and verifies', async () => {
      setupClassF();
      const pgid = await spawnLeaderlessGroup();
      try {
        writeRecord({ verifyPgid: pgid, verifyPgidAt: ago(3 * 60 * 60_000), verifyPgidStart: A_DIFFERENT_START });
        const prepared = run(['prepare', String(PR)]);
        expect(prepared.status).toBe(0);
        expect(prepared.stderr).not.toContain('二重に走らせません');
        expect(prepared.stderr).toContain('元の verify かは不明です');
        expect(prepared.stderr).toContain('止めずに、prepare を進めます');
        const check = prepared.stderr.indexOf(`pgrep -g ${pgid} -l`);
        const kill = prepared.stderr.indexOf(`kill -TERM -${pgid}`);
        expect(check).toBeGreaterThan(-1);
        expect(kill).toBeGreaterThan(check);
        expect(verified()).toHaveLength(1);
        expect(isProcessGroupAlive(pgid)).toBe(true); // 案内だけ: prepare はグループに触れない
        expect(existsSync(recordFile())).toBe(false);
      } finally {
        killGroupQuietly(pgid);
      }
    });

    it('a live leader started at the recorded time is the original verify: 75; started at another time is a reused pid: notice and go on', () => {
      setupClassF();
      const leader = spawnGroupLeader();
      try {
        writeRecord({ verifyPgid: leader.pid, verifyPgidAt: ago(3 * 60 * 60_000), verifyPgidStart: processStartTime(leader.pid) });
        const stopped = run(['prepare', String(PR)]);
        expect(stopped.status).toBe(75); // 開始時刻が同じなら、何時間経っていても元の verify
        expect(verified()).toEqual([]);

        writeRecord({ verifyPgid: leader.pid, verifyPgidAt: ago(0), verifyPgidStart: A_DIFFERENT_START });
        const proceeded = run(['prepare', String(PR)]);
        expect(proceeded.status).toBe(0);
        expect(proceeded.stderr).toContain(`verify プロセスグループ ${leader.pid} の記録は、別のプロセスに再利用された古い記録`);
        expect(verified()).toHaveLength(1);
        expect(existsSync(recordFile())).toBe(false);
      } finally {
        killGroupQuietly(leader.pid);
      }
    });

    it('a group that is gone, or a record that cannot be read, is not a reason to wait', () => {
      setupClassF();
      const gonePgid = spawnSync(process.execPath, ['-e', '']).pid; // 終わったプロセスの PID = もう居ないグループ
      writeRecord({ verifyPgid: gonePgid, verifyPgidAt: ago(0), verifyPgidStart: processStartTime(process.pid) });
      const gone = run(['prepare', String(PR)]);
      expect(gone.status).toBe(0);
      expect(gone.stderr).not.toContain('二重に走らせません');
      expect(verified()).toHaveLength(1);
      expect(existsSync(recordFile())).toBe(false);

      setupClassF();
      mkdirSync(path.dirname(recordFile()), { recursive: true });
      writeFileSync(recordFile(), '{ not json');
      expect(run(['prepare', String(PR)]).status).toBe(0);
    });

    it('--dry-run starts no verify, so a live orphan does not stop it and the record is left alone', async () => {
      setup({ merge: { mode: 'S2' } });
      const pgid = await spawnLeaderlessGroup();
      try {
        writeRecord({ verifyPgid: pgid, verifyPgidAt: ago(0), verifyPgidStart: null });
        const dry = run(['prepare', String(PR), '--dry-run']);
        expect(dry.status).toBe(0);
        expect(dry.stderr).not.toContain('二重に走らせません');
        expect(existsSync(recordFile())).toBe(true);
      } finally {
        killGroupQuietly(pgid);
      }
    });
  });
});
