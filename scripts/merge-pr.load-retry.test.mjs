// bdboard-xdk8: 着地後検証の failure が全部時間切れの形 (負荷由来) なら 1 回だけ再実行してから記録する。
// 分類器 (scripts/merge-pr/load-retry.mjs) の単体と、偽の gh / bd / npm を使った merge-pr の通しの確認。
// 偽の検証コマンドは FAKE_VERIFY_OUTPUT_FILE の中身をログに出し、FAKE_VERIFY_EXIT_SEQUENCE の順に終了する。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyVerifyFailure, retryLoadInduced } from './merge-pr/load-retry.mjs';
import {
  advanceMain,
  auditText,
  CONTEXT,
  env,
  head,
  landSquash,
  mainCheckout,
  posted,
  PR,
  readFake,
  registerTempRepoHooks,
  run,
  setup,
  simulateMerge,
  stateFile,
  status,
  tmp,
  verified,
  work,
  writeFake,
} from './merge-pr.test-support.mjs';
import { VERIFY_JS } from './merge-pr.test-support-verify-js.mjs';
import { SLOT_IDENTITY_ENV } from './verify-slot.mjs';

const banner = (script, command) => `\n> bdboard@0.1.2 ${script}\n> ${command}\n`;
const vitestLog = (body, summary) =>
  `${banner('verify:steps', 'npm run check:file-size && npm run test:server')}${banner('test:server', 'vitest run')}\n RUN  v4.1.11 /repo\n\n${body}\n Test Files  ${summary}\n      Tests  4 failed | 100 passed (104)\n`;

const TIMEOUTS = `⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/components/ChatPanel.stream-abort.test.tsx > aborts the stream
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/components/ChatPanel.stream-abort.test.tsx:42:3

⎯⎯⎯⎯[1/2]⎯

 FAIL  src/components/PresetControl.test.tsx > renames
\u001b[31mError: Test timed out in 5000ms.\u001b[39m
⎯⎯⎯⎯[2/2]⎯

⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯

Vitest caught 1 unhandled error during the test run.

⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯
Error: [vitest-pool]: Timeout starting forks runner.
`;

describe('classifyVerifyFailure (bdboard-xdk8)', () => {
  it('calls a vitest failure load-induced only when every failure is a timeout', () => {
    expect(classifyVerifyFailure(vitestLog(TIMEOUTS, '2 failed | 100 passed (102)'))).toMatchObject({ loadInduced: true, timeouts: 3 });
  });

  it('does not retry when any failure is not a timeout (including the spawnSync status-null shape)', () => {
    const nullStatus = `${TIMEOUTS}\n FAIL  scripts/merge-pr.test.mjs > finish\nAssertionError: expected null to be +0 // Object.is equality\n`;
    expect(classifyVerifyFailure(vitestLog(nullStatus, '3 failed | 100 passed (103)'))).toMatchObject({ loadInduced: false });
    const oddName = ` FAIL  a.test.ts > b\nTimeoutish: something else\n`;
    expect(classifyVerifyFailure(vitestLog(oddName, '1 failed | 1 passed (2)')).loadInduced).toBe(false);
    const strayError = `${TIMEOUTS}\nstderr | x.test.ts\nTypeError: cannot read properties of undefined\n`;
    expect(classifyVerifyFailure(vitestLog(strayError, '2 failed | 100 passed (102)')).loadInduced).toBe(false);
  });

  it('matches a timeout shape only at the start of the message, not inside an assertion about one', () => {
    // アサーションのメッセージが時間切れの文言を含むだけ (テストが時間切れの表示を検査している等) は本物の失敗。
    const quoted = ` FAIL  src/a.test.ts > shows the timeout\nAssertionError: expected 'Test timed out in 5000ms.' to be 'done' // Object.is equality\n`;
    expect(classifyVerifyFailure(vitestLog(quoted, '1 failed | 1 passed (2)'))).toMatchObject({ loadInduced: false });
    const trailing = ` FAIL  src/a.test.ts > b\nError: retry gave up: [vitest-pool]: Timeout starting forks runner.\n`;
    expect(classifyVerifyFailure(vitestLog(trailing, '1 failed | 1 passed (2)')).loadInduced).toBe(false);
    // 字下げ・エラー名 (コード付きを含む) を外した先頭なら時間切れ。
    const prefixed = ` FAIL  src/a.test.ts > b\n    Error: Hook timed out in 10000ms.\n FAIL  src/c.test.ts > d\nTypeError [ERR_X]: Test timed out in 5000ms.\n`;
    expect(classifyVerifyFailure(vitestLog(prefixed, '2 failed | 1 passed (3)'))).toMatchObject({ loadInduced: true, timeouts: 2 });
    // vitest 4 は birpc のタイマーを張らない (load-retry.mjs の TIMEOUT_SHAPES) ので、出たら想定外として再実行しない。
    const birpc = ` FAIL  src/a.test.ts > b\nError: [birpc] timeout on calling "onTaskUpdate"\n`;
    expect(classifyVerifyFailure(vitestLog(birpc, '1 failed | 1 passed (2)')).loadInduced).toBe(false);
  });

  it('counts a spawnSync child killed by its timeout (ETIMEDOUT) only as the headline, not mid-line or quoted', () => {
    const killed = ` FAIL  scripts/a.test.mjs > b\nError: spawnSync /bin/sh ETIMEDOUT\n ❯ scripts/a.test.mjs:10:3\n`;
    expect(classifyVerifyFailure(vitestLog(killed, '1 failed | 1 passed (2)'))).toMatchObject({ loadInduced: true, timeouts: 1 });
    const midLine = ` FAIL  scripts/a.test.mjs > b\nError: git failed: spawnSync /bin/sh ETIMEDOUT\n`;
    expect(classifyVerifyFailure(vitestLog(midLine, '1 failed | 1 passed (2)')).loadInduced).toBe(false);
    const quoted = ` FAIL  scripts/a.test.mjs > b\nAssertionError: expected 'spawnSync /bin/sh ETIMEDOUT' to be undefined\n`;
    expect(classifyVerifyFailure(vitestLog(quoted, '1 failed | 1 passed (2)')).loadInduced).toBe(false);
    const otherCode = ` FAIL  scripts/a.test.mjs > b\nError: spawnSync /bin/sh ENOENT\n`;
    expect(classifyVerifyFailure(vitestLog(otherCode, '1 failed | 1 passed (2)')).loadInduced).toBe(false);
  });
});

describe('retryLoadInduced: the retry reservation never outlives the call (bdboard-xdk8)', () => {
  it('removes the reservation in finally on the path that does not retry, and leaves no exit hook behind', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'load-retry-reservation-'));
    const saved = { dir: process.env.BDBOARD_VERIFY_SLOT_DIR, slots: process.env.BDBOARD_VERIFY_SLOTS };
    const exitHooks = process.listenerCount('exit');
    try {
      const slotDir = path.join(dir, 'slots'); // まだ無い: 予約を置いたなら reserveVerifySlot が作る
      process.env.BDBOARD_VERIFY_SLOT_DIR = slotDir;
      process.env.BDBOARD_VERIFY_SLOTS = '2';
      const logPath = path.join(dir, 'landed-verify.log');
      writeFileSync(logPath, vitestLog(' FAIL  a.test.ts > b\nAssertionError: expected 1 to be 2\n', '1 failed | 1 passed (2)'));
      const attempt = { ctx: {}, sha: 'abc123', logPath, activeChild: {} };
      const result = await retryLoadInduced({ attempt, queue: { priority: 'landed' }, code: 1, by: 'test', firstQueuedAt: Date.now() - 60_000 });
      expect(result).toEqual({ code: 1, retried: null });
      expect(existsSync(slotDir)).toBe(true);
      expect(readdirSync(slotDir)).toEqual([]);
      expect(process.listenerCount('exit')).toBe(exitHooks);
    } finally {
      for (const [name, value] of [['BDBOARD_VERIFY_SLOT_DIR', saved.dir], ['BDBOARD_VERIFY_SLOTS', saved.slots]]) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not retry when the failing step is not vitest, or vitest shows no failure summary', () => {
    const tsc = `${banner('build', 'tsc --noEmit')}src/a.ts(1,1): error TS2322: Type 'string' is not assignable.\nError: Test timed out in 5000ms.\n`;
    expect(classifyVerifyFailure(tsc)).toMatchObject({ loadInduced: false });
    expect(classifyVerifyFailure(`${banner('test:server', 'vitest run')}Error: Test timed out in 5000ms.\n`).loadInduced).toBe(false);
    // vitest は緑で、その後のステップ (depcruise) が落ちた
    const later = `${vitestLog('', '100 passed (100)')}${banner('check:boundaries', 'npm run depcruise')}error no-circular\n`;
    expect(classifyVerifyFailure(later).loadInduced).toBe(false);
    expect(classifyVerifyFailure('').loadInduced).toBe(false);
  });
});

const mergeDir = () => path.join(mainCheckout, '.git', 'bdboard-merge');
const landedLogs = () => readdirSync(mergeDir()).filter((name) => name.startsWith('landed-verify-'));
const slotDir = () => path.join(tmp, 'verify-slots');
const probeLog = () => path.join(tmp, 'probe.jsonl');
const probes = () => (existsSync(probeLog()) ? readFileSync(probeLog(), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);

// 偽の verify (VERIFY_JS) の前に足す観測用の前置き。何回目の実行か・祖先の pid・状態ファイルの verifyPgid
// (finish の onSpawn が書く。書かれるまで最大 5 秒待つ)・verify スロットの置き場にある holder・再実行に渡る env を
// PROBE_LOG に 1 行ずつ残し、ログには `probe attempt N` を出す。VERIFY_JS と名前がぶつからないようブロックで囲む。
const PROBE = `{
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const counter = process.env.PROBE_LOG + '.n';
  const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(attempt));
  const ancestors = [];
  for (let pid = process.pid, depth = 0; depth < 4; depth += 1) {
    pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim());
    if (!pid) break;
    ancestors.push(pid);
  }
  let pgid;
  for (const deadline = Date.now() + 5000; ; ) {
    try { pgid = JSON.parse(fs.readFileSync(process.env.PROBE_STATE_FILE, 'utf8')).verifyPgid; } catch { pgid = undefined; }
    if (pgid === process.pid || pgid === ancestors[0] || Date.now() > deadline) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  const dir = process.env.BDBOARD_VERIFY_SLOT_DIR;
  const holders = fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
  const record = { attempt, at: Date.now(), pid: process.pid, ancestors, pgid, holders, handoff: process.env.BDBOARD_VERIFY_SLOT_HANDOFF || null, queueSince: process.env.BDBOARD_VERIFY_QUEUE_SINCE || null };
  fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(record) + '\\n');
  process.stdout.write('probe attempt ' + attempt + '\\n');
}
`;
const probeEnv = () => ({ PROBE_LOG: probeLog(), PROBE_STATE_FILE: stateFile() });

function loadRetryEnv(exits) {
  const output = path.join(tmp, 'fake-verify-output.txt');
  writeFileSync(output, vitestLog(TIMEOUTS, '2 failed | 100 passed (102)'));
  return { FAKE_VERIFY_OUTPUT_FILE: output, FAKE_VERIFY_EXIT_SEQUENCE: exits, FAKE_VERIFY_SEQUENCE_FILE: path.join(tmp, 'fake-verify-seq') };
}

// bdboard-e8jj: 再実行の verify が予約を消せない (unlink が EPERM) 状況の子 (merge-pr.test-support-retry-child.mjs)。
// 子は本物の acquireVerifySlot で自分の holder を書き、見えたことを RETRY_CHILD_REPORT に残す。
const RETRY_CHILD = fileURLToPath(new URL('./merge-pr.test-support-retry-child.mjs', import.meta.url));
const retryChildVerifyJs = () =>
  `if (process.env.BDBOARD_VERIFY_SLOT_HANDOFF) require('node:child_process').execFileSync(process.execPath, [${JSON.stringify(RETRY_CHILD)}], { stdio: 'inherit' });\n${VERIFY_JS}`;

// retryLoadInduced を merge-pr の別プロセスではなくこのプロセスで呼ぶ。呼び出しが戻った時点で予約が無いこと (merge-pr の
// finally が消したこと) を見るには、プロセスが生きている間に見る必要がある: 別プロセスの merge-pr は終了時の 'exit' フックも
// 予約を消すので、終わった後の置き場を見ても finally の有無が区別できない。gh / audit / スロットの置き場は setup() の偽の環境に向ける。
describe.skipIf(process.platform === 'win32')('retryLoadInduced: a reservation the retry cannot delete is gone when the call returns (bdboard-e8jj)', { timeout: 30_000 }, () => {
  registerTempRepoHooks();
  const NAMES = [
    ...SLOT_IDENTITY_ENV, 'BDBOARD_VERIFY_SLOTS', 'BDBOARD_VERIFY_SLOT_DIR', 'BDBOARD_VERIFY_SLOT_WAIT_MS', 'BDBOARD_MERGE_GH', 'BDBOARD_MERGE_BD',
    'BDBOARD_MERGE_NPM', 'BDBOARD_MERGE_FAKE_STATE', 'BDBOARD_MERGE_AUDIT_LOG', 'BDBOARD_MERGE_POLL_MS', 'RETRY_CHILD_REPORT', 'RETRY_CHILD_WAIT_MS',
  ];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('removes it in the finally when the watch never sees the retry holder', async () => {
    setup();
    for (const name of [...SLOT_IDENTITY_ENV, 'BDBOARD_VERIFY_SLOTS', 'BDBOARD_VERIFY_SLOT_WAIT_MS']) {
      delete process.env[name]; // 外側の verify (landed の掃引など) の素性を受け継がない
    }
    const report = path.join(tmp, 'retry-child-report.json');
    Object.assign(process.env, {
      ...Object.fromEntries(Object.entries(env).filter(([name]) => NAMES.includes(name))),
      BDBOARD_MERGE_POLL_MS: '3600000', // 見張りは動かない: 消せるのは finally だけ
      RETRY_CHILD_REPORT: report,
      RETRY_CHILD_WAIT_MS: '300',
    });
    const logPath = path.join(tmp, 'landed-verify.log');
    writeFileSync(logPath, vitestLog(TIMEOUTS, '2 failed | 100 passed (102)'));
    const attempt = {
      ctx: { cwd: work, repo: 'example/demo', statusContext: CONTEXT },
      root: work,
      sha: head,
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(RETRY_CHILD)}`,
      logPath,
      activeChild: { current: undefined, interrupted: false },
      ledger: false,
    };
    const exitHooks = process.listenerCount('exit');
    const result = await retryLoadInduced({ attempt, queue: { priority: 'landed' }, code: 1, by: 'test', firstQueuedAt: Date.now() - 60_000 });
    expect(result).toEqual({ code: 0, retried: { timeouts: 3 } });
    const seen = JSON.parse(readFileSync(report, 'utf8'));
    expect(seen.presentAtStart).toBe(true);
    expect(seen.warnings.join('\n')).toMatch(/could not remove the landed retry reservation .*\(EPERM\)/);
    expect(seen.goneWhileRunning).toBe(false); // 再実行が走っている間は残っていた (消せる者が居ない)
    expect(readdirSync(slotDir())).toEqual([]); // 戻った後は無い: finally が消した
    expect(process.listenerCount('exit')).toBe(exitHooks);
  });
});

describe.skipIf(process.platform === 'win32')('merge-pr finish: one retry after a load-induced landed failure (bdboard-xdk8)', { timeout: 30_000 }, () => {
  registerTempRepoHooks();

  it('records success after the retry passes, says so on the ledger and in the audit, and keeps the first log', () => {
    setup({ branchFiles: { 'verify.cjs': PROBE + VERIFY_JS } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], { ...loadRetryEnv('1,0'), ...probeEnv() });
    expect(finished.status, finished.stderr).toBe(0);
    expect(verified()).toHaveLength(2);
    expect(finished.stderr).toContain('負荷由来とみなし、1 回だけ再実行します');
    const states = posted().map(({ sha, state }) => [sha, state]);
    expect(states).toEqual([[landed, 'pending'], [landed, 'pending'], [landed, 'success']]);
    expect(posted().at(-1).description).toContain('retried after load-induced failure: 3 timeouts');
    expect(readFake().slot.holder).toBeNull();
    expect(auditText()).toMatch(/\tlanded-verify-retry\t.*exit=1\ttimeouts=3\t/);
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=success\tretried=1\n/);
    // 残したのは 1 回目のログで、今の名前のログは 2 回目のもの (中身が同じ偽の出力なので、何回目かで見分ける)。
    const kept = landedLogs().filter((name) => name.includes('.first-attempt-'));
    expect(kept).toHaveLength(1);
    const keptText = readFileSync(path.join(mergeDir(), kept[0]), 'utf8');
    expect(keptText).toMatch(/^probe attempt 1$/m);
    expect(keptText).toMatch(/^Error: Test timed out in 5000ms\.$/m);
    const current = landedLogs().filter((name) => !name.includes('.first-attempt-'));
    expect(current).toHaveLength(1);
    expect(readFileSync(path.join(mergeDir(), current[0]), 'utf8')).toMatch(/^probe attempt 2$/m);
  });

  it('holds the verify slot with a landed reservation while the retry starts, and hands it to the retry (F3)', () => {
    setup({ branchFiles: { 'verify.cjs': PROBE + VERIFY_JS } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    expect(run(['finish', String(PR)], { ...loadRetryEnv('1,0'), ...probeEnv() }).status).toBe(0);
    const [first, second] = probes();
    expect(first).toMatchObject({ attempt: 1, holders: [], handoff: null });
    // 1 回目が抜けた直後に merge-pr (= 再実行の verify の祖先) が置いた予約。landed の待ち手として並び、
    // 並んだ時刻は 1 回目に並んだ時刻を引き継ぐ (seniority)。
    expect(second.attempt).toBe(2);
    expect(second.holders).toHaveLength(1);
    const [reservation] = second.holders;
    expect(reservation).toMatchObject({ v: 2, priority: 'landed', reserved: true });
    expect(reservation.acquiredAt).toBeUndefined();
    expect(second.ancestors).toContain(reservation.pid);
    expect(reservation.since).toBeLessThanOrEqual(first.at);
    expect(Number(second.queueSince)).toBe(reservation.since);
    expect(second.handoff).toBe(path.join(slotDir(), `holder-${reservation.pid}.json`));
    // 終わった後は何も残らない (再実行の verify が消すか、merge-pr の finally が消す)。
    expect(readdirSync(slotDir())).toEqual([]);
  });

  it('removes a reservation the retry could not delete (EPERM) as soon as the retry holder shows, while the retry is still running (bdboard-e8jj)', () => {
    // 再実行のときだけ (BDBOARD_VERIFY_SLOT_HANDOFF が渡る) 子を起こす偽の verify.cjs。子は本物の acquireVerifySlot を、
    // 予約の削除が EPERM で失敗する io で呼び、予約が消えるのを最大 RETRY_CHILD_WAIT_MS 待つ。
    setup({ branchFiles: { 'verify.cjs': retryChildVerifyJs() } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const report = path.join(tmp, 'retry-child-report.json');
    const finished = run(['finish', String(PR)], { ...loadRetryEnv('1,0'), RETRY_CHILD_REPORT: report, RETRY_CHILD_WAIT_MS: '8000', BDBOARD_MERGE_POLL_MS: '50' });
    expect(finished.status, finished.stderr).toBe(0);
    expect(verified()).toHaveLength(2);
    expect(posted().at(-1).state).toBe('success');
    const seen = JSON.parse(readFileSync(report, 'utf8'));
    expect(seen.presentAtStart).toBe(true);
    expect(seen.warnings.join('\n')).toMatch(/could not remove the landed retry reservation .*\(EPERM\)/);
    expect(seen.goneWhileRunning).toBe(true); // 再実行がまだ走っている間に、merge-pr が見張りで消した
    expect(readdirSync(slotDir())).toEqual([]);
  });

  it('records the new verify process group on the retry too (bdboard-ky9l onSpawn)', () => {
    setup({ branchFiles: { 'verify.cjs': PROBE + VERIFY_JS } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    expect(run(['finish', String(PR)], { ...loadRetryEnv('1,0'), ...probeEnv() }).status).toBe(0);
    const [first, second] = probes();
    for (const probe of [first, second]) {
      expect([probe.pid, probe.ancestors[0]]).toContain(probe.pgid); // そのときの verify のグループ (シェルか verify 自身)
    }
    expect(second.pgid).not.toBe(first.pgid);
  });

  it('records failure (main-broken) when the retry fails too', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], loadRetryEnv('1,1'));
    expect(finished.status).toBe(6);
    expect(verified()).toHaveLength(2);
    expect(posted().map(({ state }) => state)).toEqual(['pending', 'pending', 'failure']);
    expect(posted().at(-1).description).toContain('retried after load-induced failure');
    expect(readFake().slot.holder).toContain(`main-broken ${landed.slice(0, 12)}`);
  });

  it('records error, not failure, when the retry ends in a verify slot wait timeout (exit 75), and keeps the first log', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], loadRetryEnv('1,75'));
    expect(finished.status).toBe(1); // EXIT.USAGE (検証を実行できなかった)。6 (LANDED_FAILED) ではない
    expect(verified()).toHaveLength(2);
    expect(finished.stderr).toContain('verify スロットの待ちがタイムアウトしました');
    expect(posted().map(({ sha, state }) => [sha, state])).toEqual([[landed, 'pending'], [landed, 'pending']]);
    expect(readFake().slot.holder).toBeNull(); // main-broken の枠を取っていない
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=error\tretried=1\n/);
    expect(landedLogs().filter((name) => name.includes('.first-attempt-'))).toHaveLength(1);
    expect(readdirSync(slotDir())).toEqual([]);
  });

  it('carries the retry into the light-landed line of a class L landing (S3), and never retries the light check itself', () => {
    setup({ merge: { mode: 'S3', lightCheck: 'node verify.cjs --light' } });
    const moved = advanceMain({ 'peer.txt': 'peer\n' });
    // 軽量チェック (ledger: false) は時間切れだけの失敗でも再実行しない (bdboard-e8jj: 意味的衝突 (exit 3) とも扱わず、
    // exit 75 で prepare のやり直しを案内する)。回数は着地後検証と別に数える。
    const prepared = run(['prepare', String(PR)], { ...loadRetryEnv('1,0'), FAKE_VERIFY_SEQUENCE_FILE: path.join(tmp, 'fake-verify-seq-light') });
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain('着地予定ツリーの軽量チェックは失敗しましたが');
    expect(prepared.stderr).toContain(`prepare を再実行してください: npm run merge-pr -- prepare ${PR}`);
    expect(verified()).toHaveLength(1);
    expect(prepared.stderr).not.toContain('1 回だけ再実行します');
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(readFake().slot.holder).toBeNull();
    writeFake({ statuses: { [moved]: [status('success')] } });
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = landSquash();
    const finished = run(['finish', String(PR)], loadRetryEnv('1,0'));
    expect(finished.status, finished.stderr).toBe(0);
    expect(verified().filter((line) => line === landed)).toHaveLength(2);
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=success\tretried=1\n/);
    expect(auditText()).toMatch(new RegExp(`\tlight-landed\tpr=${PR}\tid=demo-1\tnew=${landed}\tresult=success\tby=finish\tretried=1\n`));
  });

  // bdboard-e8jj: S2 の着地予定ツリーの verify (predicted.mjs) の failure を、ログの形で分ける。全部時間切れの形 (負荷由来)
  // なら意味的衝突とは扱わず exit 75 で prepare のやり直しを案内し、それ以外は今までどおり exit 3 (rebase に格下げ)。
  // どちらも自動の再実行はしない (verified() が 1 回)。偽の verify (VERIFY_JS) は FAKE_VERIFY_OUTPUT_FILE の中身をログに出す。
  function predictedWith(output) {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const file = path.join(tmp, 'predicted-output.txt');
    writeFileSync(file, output);
    const prepared = run(['prepare', String(PR)], { FAKE_VERIFY_OUTPUT_FILE: file, FAKE_VERIFY_EXIT: '1' });
    expect(verified()).toHaveLength(1);
    expect(auditText()).toMatch(/\tpredicted-verify\t.*\tresult=failure\t/); // 監査の result は分類に関わらず failure
    expect(existsSync(stateFile())).toBe(false); // gate に進ませない
    expect(auditText()).not.toContain('landed-verify-retry');
    expect(existsSync(slotDir())).toBe(false);
    return prepared;
  }

  it.each([
    ['vitest timeouts only', vitestLog(TIMEOUTS, '2 failed | 100 passed (102)'), '3 件'],
    ['a spawnSync child killed by its timeout', vitestLog(' FAIL  scripts/a.test.mjs > b\nError: spawnSync /bin/sh ETIMEDOUT\n', '1 failed | 1 passed (2)'), '1 件'],
  ])('a predicted verify that failed with %s is load-induced: exit 75 and "run prepare again", not a rebase', (_name, output, count) => {
    const prepared = predictedWith(output);
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain(`失敗 ${count}はすべて時間切れの形 (負荷由来)`);
    expect(prepared.stderr).toContain(`prepare を再実行してください: npm run merge-pr -- prepare ${PR}`);
    expect(prepared.stderr).not.toContain('git rebase'); // rebaseSteps の案内は出さない
    expect(prepared.stderr).not.toContain('意味的衝突の可能性が高い');
    expect(run(['prepare', String(PR)]).status).toBe(0); // 偽の verify が緑なら、そのまま prepare し直せる
  });

  it.each([
    ['an assertion failure', vitestLog(' FAIL  a.test.ts > b\nAssertionError: expected 1 to be 2\n', '1 failed | 1 passed (2)')],
    ['timeouts mixed with one assertion failure', vitestLog(`${TIMEOUTS}\n FAIL  b.test.ts > c\nAssertionError: expected 1 to be 2\n`, '3 failed | 1 passed (4)')],
    ['a failing step that is not vitest', `${banner('build', 'tsc --noEmit')}src/a.ts(1,1): error TS2322: Type 'string' is not assignable.\nError: Test timed out in 5000ms.\n`],
    ['a log with no failure message', 'something went wrong\n'],
  ])('a predicted verify that failed with %s is still a rebase conflict (exit 3)', (_name, output) => {
    const prepared = predictedWith(output);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('意味的衝突の可能性が高い');
    expect(prepared.stderr).toContain('git rebase');
    expect(prepared.stderr).not.toContain('prepare を再実行してください');
    expect(existsSync(timeoutsRecord())).toBe(false); // 時間切れだけではない失敗は、1 回目の記録も残さない
  });

  // bdboard-e8jj (PR #871 レビュー指摘 1): 時間切れだけの失敗で exit 75 にするのは同じ着地予定ツリーにつき 1 回だけ。
  // 決定的なハング (毎回時間切れになる意味的衝突) が毎回 75 のまま rebase に格下げされないのを防ぐ。
  const timeoutsRecord = () => path.join(mergeDir(), `pr-${PR}-predicted-timeouts.json`);
  const prepareWith = (output, extraEnv = {}) => {
    const file = path.join(tmp, 'predicted-output.txt');
    writeFileSync(file, output);
    return run(['prepare', String(PR)], { FAKE_VERIFY_OUTPUT_FILE: file, FAKE_VERIFY_EXIT: '1', ...extraEnv });
  };
  const predictedAudit = (event = 'predicted-verify') => auditText().split('\n').filter((line) => line.includes(`\t${event}\t`));
  const onlyTimeouts = vitestLog(TIMEOUTS, '2 failed | 100 passed (102)');

  it('allows one load-induced exit 75 per predicted tree: the same tree failing with only timeouts again is exit 3 (a likely deterministic hang)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const first = prepareWith(onlyTimeouts);
    expect(first.status).toBe(75);
    expect(first.stderr).toContain('prepare を再実行してください');
    const recorded = JSON.parse(readFileSync(timeoutsRecord(), 'utf8'));
    expect(recorded).toEqual({ pr: PR, tree: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const second = prepareWith(onlyTimeouts);
    expect(second.status).toBe(3);
    expect(second.stderr).toContain('同じ着地予定ツリーで 2 回続けて');
    expect(second.stderr).toContain('決定的なハング');
    expect(second.stderr).toContain('git rebase'); // rebaseSteps の案内まで出る
    expect(second.stderr).not.toContain('prepare を再実行してください');
    expect(JSON.parse(readFileSync(timeoutsRecord(), 'utf8'))).toEqual(recorded); // 格下げした後も記録は残る
    expect(prepareWith(onlyTimeouts).status).toBe(3); // 同じツリーは何度やり直しても 3 (75 に戻らない)
    expect(verified()).toHaveLength(3);
    expect(existsSync(stateFile())).toBe(false);
    // 監査: result はどれも failure。時間切れだけの失敗は loadInduced=1 と件数を持ち、2 回目からは repeated=1 も持つ。
    const lines = predictedAudit();
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.includes('\tresult=failure\t'))).toBe(true);
    expect(lines[0]).toMatch(/\tloadInduced=1\ttimeouts=3$/);
    expect(lines[1]).toMatch(/\tloadInduced=1\ttimeouts=3\trepeated=1$/);
    expect(lines[2]).toMatch(/\tloadInduced=1\ttimeouts=3\trepeated=1$/);
  });

  it('counts again from one when the predicted tree is a different one (main moved)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(75);
    const firstTree = JSON.parse(readFileSync(timeoutsRecord(), 'utf8')).tree;
    advanceMain({ 'peer2.txt': 'peer two\n' }); // main が動けば着地予定ツリーも変わる
    expect(prepareWith(onlyTimeouts).status).toBe(75); // 別のツリーの 1 回目: また 75
    const secondTree = JSON.parse(readFileSync(timeoutsRecord(), 'utf8')).tree;
    expect(secondTree).not.toBe(firstTree);
    expect(prepareWith(onlyTimeouts).status).toBe(3); // その同じツリーの 2 回目: 3
    expect(predictedAudit().map((line) => /\trepeated=1$/.test(line))).toEqual([false, false, true]);
  });

  it('clears the record on a predicted success, so the same tree gets its one exit 75 again later', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(75);
    expect(existsSync(timeoutsRecord())).toBe(true);
    const succeeded = run(['prepare', String(PR)]); // 偽の verify が緑
    expect(succeeded.status, succeeded.stderr).toBe(0);
    expect(existsSync(timeoutsRecord())).toBe(false);
    expect(prepareWith(onlyTimeouts).status).toBe(75); // 成功で数え直したので、また 1 回目
  });

  it('applies the same once-per-tree rule to the S3 light check (class L)', () => {
    setup({ merge: { mode: 'S3', lightCheck: 'node verify.cjs --light' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(75);
    const second = prepareWith(onlyTimeouts);
    expect(second.status).toBe(3);
    expect(second.stderr).toContain('軽量チェック (node verify.cjs --light) が失敗しました');
    expect(second.stderr).toContain('決定的なハング');
    const lines = predictedAudit('light-check');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\tloadInduced=1\ttimeouts=3$/);
    expect(lines[1]).toMatch(/\tloadInduced=1\ttimeouts=3\trepeated=1$/);
  });

  it('does not retry a failure that is not all timeouts', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const finished = run(['finish', String(PR)], { FAKE_VERIFY_EXIT: '1' });
    expect(finished.status).toBe(6);
    expect(verified()).toHaveLength(1);
    expect(finished.stderr).toContain('負荷由来とは判断できないので再実行しません');
    expect(posted().map(({ state }) => state)).toEqual(['pending', 'failure']);
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=failure\n/); // 再実行しなければ retried は出さない
    expect(landedLogs().some((name) => name.includes('.first-attempt-'))).toBe(false);
    expect(existsSync(path.join(tmp, 'fake-verify-seq'))).toBe(false);
  });
});
