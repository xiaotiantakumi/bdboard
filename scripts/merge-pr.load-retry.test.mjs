// bdboard-xdk8: 着地後検証の failure が全部時間切れの形 (負荷由来) なら 1 回だけ再実行してから記録する。
// 分類器 (scripts/merge-pr/load-retry.mjs) の単体と、偽の gh / bd / npm を使った merge-pr の通しの確認。
// 偽の検証コマンドは FAKE_VERIFY_OUTPUT_FILE の中身をログに出し、FAKE_VERIFY_EXIT_SEQUENCE の順に終了する。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyVerifyFailure } from './merge-pr/load-retry.mjs';
import {
  advanceMain,
  auditText,
  mainCheckout,
  posted,
  PR,
  readFake,
  registerTempRepoHooks,
  run,
  setup,
  simulateMerge,
  stateFile,
  tmp,
  verified,
} from './merge-pr.test-support.mjs';
import { VERIFY_JS } from './merge-pr.test-support-verify-js.mjs';

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

  it('does not retry the predicted-tree verify (ledger: false) even when its failures are all timeouts', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const prepared = run(['prepare', String(PR)], loadRetryEnv('1,0'));
    expect(prepared.status).toBe(3); // NEEDS_REBASE (意味的衝突として rebase に格下げ)
    expect(verified()).toHaveLength(1);
    expect(prepared.stderr).not.toContain('1 回だけ再実行します');
    expect(prepared.stderr).not.toContain('負荷由来');
    expect(auditText()).not.toContain('landed-verify-retry');
    expect(readdirSync(mergeDir()).some((name) => name.includes('.first-attempt-'))).toBe(false);
    expect(existsSync(slotDir())).toBe(false);
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
