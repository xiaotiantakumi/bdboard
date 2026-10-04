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
  commitAll,
  CONTEXT,
  env,
  git,
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

  // bdboard-7qhq: 子プロセスの時間切れ (ETIMEDOUT) は timeouts の内数として別に数える。同じ走査の結果で、パーサは増やさない。
  it('counts the ETIMEDOUT headlines apart from the other timeouts (etimedout never exceeds timeouts when load-induced)', () => {
    const two = ` FAIL  a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\n FAIL  b.test.mjs > two\nError: spawnSync git ETIMEDOUT\n`;
    expect(classifyVerifyFailure(vitestLog(two, '2 failed | 1 passed (3)'))).toMatchObject({ loadInduced: true, timeouts: 2, etimedout: 2 });
    const withTimeout = `${TIMEOUTS}\n FAIL  c.test.mjs > three\nError: spawnSync /bin/sh ETIMEDOUT\n`;
    expect(classifyVerifyFailure(vitestLog(withTimeout, '3 failed | 1 passed (4)'))).toMatchObject({ loadInduced: true, timeouts: 4, etimedout: 1 });
    expect(classifyVerifyFailure(vitestLog(TIMEOUTS, '2 failed | 100 passed (102)'))).toMatchObject({ loadInduced: true, timeouts: 3, etimedout: 0 });
  });

  it('still counts the ETIMEDOUT headlines when a failure that is not a timeout is mixed in (not load-induced, but the count is shown)', () => {
    const mixed = ` FAIL  a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\n FAIL  b.test.mjs > two\nAssertionError: expected null to be +0 // Object.is equality\n`;
    expect(classifyVerifyFailure(vitestLog(mixed, '2 failed | 1 passed (3)'))).toMatchObject({ loadInduced: false, timeouts: 0, etimedout: 1 });
    // 見出しの先頭でない行 (途中・引用) は数えない。vitest 以外のステップで落ちたログも 0。
    const midLine = ` FAIL  a.test.mjs > b\nError: git failed: spawnSync /bin/sh ETIMEDOUT\n`;
    expect(classifyVerifyFailure(vitestLog(midLine, '1 failed | 1 passed (2)')).etimedout).toBe(0);
    expect(classifyVerifyFailure(`${banner('build', 'tsc --noEmit')}Error: spawnSync /bin/sh ETIMEDOUT\n`).etimedout).toBe(0);
    expect(classifyVerifyFailure('').etimedout).toBe(0);
  });

  // bdboard-7qhq (PR #875 レビュー指摘 1): アサーションのメッセージが長く、merge-pr の stderr をそのまま載せていると
  // `Error: spawnSync … ETIMEDOUT` の行が途中に繰り返される。それは新しい失敗ではないので数えない
  // (FAIL 行か見出しの帯の直後の見出しだけ数える。loadInduced の判定に使う見出しの集合は今までどおり)。
  it('does not count an ETIMEDOUT line that a multi-line AssertionError message merely repeats', () => {
    const echoed = [
      ' FAIL  scripts/a.test.mjs > one',
      'Error: spawnSync /bin/sh ETIMEDOUT',
      ' ❯ scripts/a.test.mjs:10:3',
      '',
      ' FAIL  scripts/b.test.mjs > two',
      'Error: spawnSync git ETIMEDOUT',
      '',
      ' FAIL  scripts/c.test.mjs > three',
      'AssertionError: merge-pr failed:',
      'merge-pr: verify が失敗しました (exit 1)。',
      'Error: spawnSync /bin/sh ETIMEDOUT',
      ' ❯ scripts/c.test.mjs:20:3',
      '',
    ].join('\n');
    expect(classifyVerifyFailure(vitestLog(echoed, '3 failed | 1 passed (4)'))).toMatchObject({ loadInduced: false, timeouts: 0, etimedout: 2 });
    // 見出しの帯 (Unhandled Rejection) の直後の見出しは数える。
    const banner2 = `⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯\nError: spawnSync /bin/sh ETIMEDOUT\n`;
    expect(classifyVerifyFailure(vitestLog(banner2, '1 failed | 1 passed (2)'))).toMatchObject({ loadInduced: true, timeouts: 1, etimedout: 1 });
    // 時間切れの見出しだけの失敗の途中に繰り返しがあっても、timeouts (見出しの集合) は変わらず、etimedout は数えた分だけ。
    const onlyTimeouts = ` FAIL  scripts/a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\nError: spawnSync /bin/sh ETIMEDOUT\n`;
    expect(classifyVerifyFailure(vitestLog(onlyTimeouts, '1 failed | 1 passed (2)'))).toMatchObject({ loadInduced: true, timeouts: 2, etimedout: 1 });
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

function loadRetryEnv(exits, text = vitestLog(TIMEOUTS, '2 failed | 100 passed (102)')) {
  const output = path.join(tmp, 'fake-verify-output.txt');
  writeFileSync(output, text);
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

  // bdboard-7qhq: ログにある子プロセスの時間切れ (spawnSync ETIMEDOUT) の件数を、メッセージと監査行に出す。
  // 負荷下の失敗の見出しは `Error: spawnSync /bin/sh ETIMEDOUT` としか出ないので、人が原因を読み違えないようにする。
  const killedByTimeout = vitestLog(
    ' FAIL  scripts/a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\n\n FAIL  scripts/b.test.mjs > two\nError: spawnSync git ETIMEDOUT\n',
    '2 failed | 100 passed (102)',
  );
  // 件数 count の行が stderr に何回出たか (重複して出るのも見つけるため、toContain ではなく数える)。
  const etimedoutNotes = (stderr, count = 2) => stderr.split(`子プロセスの時間切れ (ETIMEDOUT) が ${count} 件`).length - 1;
  // 2 回の実行で ETIMEDOUT の件数が違うログ (1 回目は 2 件、再実行は 1 件) を出す偽の verify.cjs。FAKE_VERIFY_SEQUENCE_FILE が
  // あれば 2 回目以降 (VERIFY_JS が終了時に数える前なので、ファイルがあれば 1 回は走っている) で別の出力ファイルに差し替える。
  const SWITCH_OUTPUT_ON_RETRY = `{
  const seq = process.env.FAKE_VERIFY_SEQUENCE_FILE;
  if (process.env.FAKE_VERIFY_OUTPUT_FILE_RETRY && seq && require('node:fs').existsSync(seq)) process.env.FAKE_VERIFY_OUTPUT_FILE = process.env.FAKE_VERIFY_OUTPUT_FILE_RETRY;
}
`;

  it('says how many child processes hit their timeout (ETIMEDOUT) when it retries, and puts etimedout=N on the retry audit line', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const finished = run(['finish', String(PR)], loadRetryEnv('1,0', killedByTimeout));
    expect(finished.status, finished.stderr).toBe(0);
    expect(verified()).toHaveLength(2);
    expect(finished.stderr).toContain('負荷由来とみなし、1 回だけ再実行します');
    expect(etimedoutNotes(finished.stderr)).toBe(1); // 再実行の案内に 1 回 (通ったので failure の行は出ない)
    expect(auditText()).toMatch(/\tlanded-verify-retry\t.*exit=1\ttimeouts=2\tetimedout=2\t/);
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=success\tretried=1\n/); // 通った回の行には件数を出さない
  });

  it('says it again on the failure message and puts etimedout=N on the landed-verify audit line when the retry fails too', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const finished = run(['finish', String(PR)], loadRetryEnv('1,1', killedByTimeout));
    expect(finished.status).toBe(6);
    expect(verified()).toHaveLength(2);
    expect(etimedoutNotes(finished.stderr)).toBe(2); // 再実行の案内 + 2 回目 (最後のログ) の failure
    expect(auditText()).toMatch(/\tlanded-verify-retry\t.*exit=1\ttimeouts=2\tetimedout=2\t/);
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=failure\tretried=1\tetimedout=2\n/);
  });

  it('counts the retry notice and the retry audit line from the first log, and the failure line and the landed-verify line from the last log', () => {
    setup({ branchFiles: { 'verify.cjs': SWITCH_OUTPUT_ON_RETRY + VERIFY_JS } });
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const oneKilled = vitestLog(' FAIL  scripts/a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\n', '1 failed | 100 passed (101)');
    const retryOutput = path.join(tmp, 'fake-verify-output-retry.txt');
    writeFileSync(retryOutput, oneKilled);
    const finished = run(['finish', String(PR)], { ...loadRetryEnv('1,1', killedByTimeout), FAKE_VERIFY_OUTPUT_FILE_RETRY: retryOutput });
    expect(finished.status).toBe(6);
    expect(verified()).toHaveLength(2);
    // 1 回目のログは 2 件: 再実行の案内と landed-verify-retry の行。2 回目のログは 1 件: failure の行と landed-verify の行。
    expect(etimedoutNotes(finished.stderr, 2)).toBe(1);
    expect(etimedoutNotes(finished.stderr, 1)).toBe(1);
    // 案内 (1 回目のログ) が先、failure の行 (2 回目のログ) が後。
    expect(finished.stderr.indexOf('(ETIMEDOUT) が 2 件')).toBeLessThan(finished.stderr.indexOf('(ETIMEDOUT) が 1 件'));
    expect(auditText()).toMatch(/\tlanded-verify-retry\t.*exit=1\ttimeouts=2\tetimedout=2\t/);
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=failure\tretried=1\tetimedout=1\n/);
  });

  it('puts etimedout=N on the audit line of a manual verify too', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const manual = run(['verify', landed], loadRetryEnv('1,1', killedByTimeout));
    expect(manual.status).toBe(6);
    expect(verified()).toHaveLength(2);
    expect(etimedoutNotes(manual.stderr)).toBe(2); // 再実行の案内 + 最後のログの failure
    expect(auditText()).toMatch(new RegExp(`\tlanded-verify\tnew=${landed}\tresult=failure\tby=manual[^\t]*\tretried=1\tetimedout=2\n`));
  });

  it('shows the ETIMEDOUT count on a landed failure that is not retried (a failure that is not a timeout is mixed in)', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const mixed = vitestLog(
      ' FAIL  scripts/a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\n\n FAIL  scripts/b.test.mjs > two\nAssertionError: expected null to be +0 // Object.is equality\n',
      '2 failed | 100 passed (102)',
    );
    const finished = run(['finish', String(PR)], loadRetryEnv('1', mixed));
    expect(finished.status).toBe(6);
    expect(verified()).toHaveLength(1);
    expect(finished.stderr).toContain('負荷由来とは判断できないので再実行しません');
    expect(finished.stderr).toContain('子プロセスの時間切れ (ETIMEDOUT) が 1 件');
    expect(auditText()).not.toContain('landed-verify-retry');
    expect(auditText()).toMatch(/\tlanded-verify\t.*\tresult=failure\tetimedout=1\n/); // 再実行しなければ retried は出ない
  });

  it('prints no ETIMEDOUT line and no etimedout field when the log has none', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    const finished = run(['finish', String(PR)], loadRetryEnv('1,1'));
    expect(finished.status).toBe(6);
    expect(finished.stderr).not.toContain('ETIMEDOUT');
    expect(auditText()).not.toContain('etimedout');
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
    ['vitest timeouts only', vitestLog(TIMEOUTS, '2 failed | 100 passed (102)'), '3 件', 0],
    ['a spawnSync child killed by its timeout', vitestLog(' FAIL  scripts/a.test.mjs > b\nError: spawnSync /bin/sh ETIMEDOUT\n', '1 failed | 1 passed (2)'), '1 件', 1],
  ])('a predicted verify that failed with %s is load-induced: exit 75 and "run prepare again", not a rebase', (_name, output, count, etimedout) => {
    const prepared = predictedWith(output);
    expect(prepared.status).toBe(75);
    expect(prepared.stderr).toContain(`失敗 ${count}はすべて時間切れの形 (負荷由来)`);
    expect(prepared.stderr).toContain(`prepare を再実行してください: npm run merge-pr -- prepare ${PR}`);
    expect(prepared.stderr).not.toContain('git rebase'); // rebaseSteps の案内は出さない
    expect(prepared.stderr).not.toContain('意味的衝突の可能性が高い');
    // bdboard-7qhq: 子プロセスの時間切れ (ETIMEDOUT) の件数をメッセージと監査行に出す (0 件なら出さない)。
    if (etimedout > 0) {
      expect(etimedoutNotes(prepared.stderr, etimedout)).toBe(1); // 1 回だけ (着地後検証の failure の行と二重に出さない)
      expect(auditText()).toMatch(new RegExp(`\tpredicted-verify\t.*\tresult=failure\t.*\tloadInduced=1\ttimeouts=1\tetimedout=${etimedout}\n`));
    } else {
      expect(prepared.stderr).not.toContain('ETIMEDOUT');
      expect(auditText()).not.toContain('etimedout');
    }
    expect(run(['prepare', String(PR)]).status).toBe(0); // 偽の verify が緑なら、そのまま prepare し直せる
  });

  // bdboard-7qhq: 他の失敗が混ざって rebase に格下げ (exit 3) される失敗でも、ログにある ETIMEDOUT の件数は見出しと監査行に出す。
  it('shows the ETIMEDOUT count on a predicted failure that is a rebase conflict (exit 3) too', () => {
    const mixed = vitestLog(
      ' FAIL  scripts/a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\n\n FAIL  scripts/b.test.mjs > two\nAssertionError: expected 1 to be 2\n',
      '2 failed | 1 passed (3)',
    );
    const prepared = predictedWith(mixed);
    expect(prepared.status).toBe(3);
    expect(prepared.stderr).toContain('意味的衝突の可能性が高い');
    expect(etimedoutNotes(prepared.stderr, 1)).toBe(1);
    const [line] = auditText().split('\n').filter((entry) => entry.includes('\tpredicted-verify\t'));
    expect(line).toMatch(/\tresult=failure\t.*\tetimedout=1$/);
    expect(line).not.toContain('loadInduced'); // 時間切れだけではないので loadInduced は付かない
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

  // bdboard-e8jj (PR #871 レビュー指摘 1): 時間切れだけの失敗で exit 75 にするのは同じ PR head につき 1 回だけ。
  // 決定的なハング (毎回時間切れになる意味的衝突) が毎回 75 のまま rebase に格下げされないのを防ぐ。記録は着地予定ツリーではなく
  // head で見る (prepare の合間に main が動くとツリーが変わり、ツリーで数えると上限が効かなくなる)。記録の読み書きの単体は
  // scripts/merge-pr.predicted-timeouts.test.mjs (こちらは POSIX だけ)。
  const timeoutsRecord = () => path.join(mergeDir(), `pr-${PR}-predicted-timeouts.json`);
  const predictedTrees = () => predictedAudit().map((line) => /\ttree=([0-9a-f]+)\t/.exec(line)[1]);
  // PR のブランチに 1 コミット足して push し、偽の gh にも新しい head を教える (PR が更新された)。
  const moveHead = () => {
    writeFileSync(path.join(work, 'more.txt'), 'more\n');
    const next = commitAll(work, 'feat(demo-1): more');
    git(work, ['push', '-q', 'origin', 'bd/demo-1']);
    const { pulls } = readFake();
    pulls[PR].head.sha = next;
    writeFake({ pulls });
    return next;
  };
  const prepareWith = (output, extraEnv = {}) => {
    const file = path.join(tmp, 'predicted-output.txt');
    writeFileSync(file, output);
    return run(['prepare', String(PR)], { FAKE_VERIFY_OUTPUT_FILE: file, FAKE_VERIFY_EXIT: '1', ...extraEnv });
  };
  const predictedAudit = (event = 'predicted-verify') => auditText().split('\n').filter((line) => line.includes(`\t${event}\t`));
  const onlyTimeouts = vitestLog(TIMEOUTS, '2 failed | 100 passed (102)');

  it('allows one load-induced exit 75 per PR head: the same head failing with only timeouts again is exit 3 (a likely deterministic hang)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    const first = prepareWith(onlyTimeouts);
    expect(first.status).toBe(75);
    expect(first.stderr).toContain('prepare を再実行してください');
    expect(first.stderr).not.toContain('前にも時間切れだけで落ちています');
    const recorded = JSON.parse(readFileSync(timeoutsRecord(), 'utf8'));
    expect(recorded).toEqual({ pr: PR, head }); // 着地予定ツリーではなく PR head
    const second = prepareWith(onlyTimeouts);
    expect(second.status).toBe(3);
    expect(second.stderr).toContain(`この PR head (${head.slice(0, 12)}) は前にも時間切れだけで落ちています`);
    expect(second.stderr).not.toContain('2 回続けて'); // 続けてとは限らない (間に別の失敗があっても記録は残る)
    expect(second.stderr).toContain('決定的なハング');
    expect(second.stderr).toContain('git rebase'); // rebaseSteps の案内まで出る
    expect(second.stderr).not.toContain('prepare を再実行してください');
    expect(JSON.parse(readFileSync(timeoutsRecord(), 'utf8'))).toEqual(recorded); // 格下げした後も記録は残る
    expect(prepareWith(onlyTimeouts).status).toBe(3); // 同じ head は何度やり直しても 3 (75 に戻らない)
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

  it('does not reset the count when main moves between the two runs (the predicted tree changes, the PR head does not): 75 then 3', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(75);
    advanceMain({ 'peer2.txt': 'peer two\n' }); // main が動けば着地予定ツリーは変わる
    const second = prepareWith(onlyTimeouts);
    expect(second.status).toBe(3); // 木が違っても head が同じなら 2 回目
    expect(second.stderr).toContain('前にも時間切れだけで落ちています');
    const [firstTree, secondTree] = predictedTrees();
    expect(secondTree).not.toBe(firstTree);
    expect(predictedAudit().map((line) => /\trepeated=1$/.test(line))).toEqual([false, true]);
    advanceMain({ 'peer3.txt': 'peer three\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(3); // main がまた動いても 3 のまま
  });

  it('counts again from one when the PR head is a different one (the PR was updated)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(75);
    const firstHead = JSON.parse(readFileSync(timeoutsRecord(), 'utf8')).head;
    const nextHead = moveHead();
    expect(nextHead).not.toBe(firstHead);
    expect(prepareWith(onlyTimeouts).status).toBe(75); // 別の head の 1 回目: また 75
    expect(JSON.parse(readFileSync(timeoutsRecord(), 'utf8'))).toEqual({ pr: PR, head: nextHead });
    expect(prepareWith(onlyTimeouts).status).toBe(3); // その head の次: 3
    expect(predictedAudit().map((line) => /\trepeated=1$/.test(line))).toEqual([false, false, true]);
  });

  it('keeps the record through a failure that is not only timeouts (it is not a consecutive count)', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(75);
    expect(prepareWith(vitestLog(' FAIL  a.test.ts > b\nAssertionError: expected 1 to be 2\n', '1 failed | 1 passed (2)')).status).toBe(3);
    expect(existsSync(timeoutsRecord())).toBe(true);
    const third = prepareWith(onlyTimeouts);
    expect(third.status).toBe(3);
    expect(third.stderr).toContain('前にも時間切れだけで落ちています'); // 間に別の失敗があっても、前にも落ちた事実は変わらない
  });

  it('finish deletes the timeouts record of the merged PR (bdboard-e8jj)', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    simulateMerge();
    writeFileSync(timeoutsRecord(), `${JSON.stringify({ pr: PR, head })}\n`); // 前に時間切れだけで落ちた記録が残っていた
    const finished = run(['finish', String(PR)]);
    expect(finished.status, finished.stderr).toBe(0);
    expect(existsSync(timeoutsRecord())).toBe(false);
  });

  it('clears the record on a predicted success, so the same head gets its one exit 75 again later', () => {
    setup({ merge: { mode: 'S2' } });
    advanceMain({ 'peer.txt': 'peer\n' });
    expect(prepareWith(onlyTimeouts).status).toBe(75);
    expect(existsSync(timeoutsRecord())).toBe(true);
    const succeeded = run(['prepare', String(PR)]); // 偽の verify が緑
    expect(succeeded.status, succeeded.stderr).toBe(0);
    expect(existsSync(timeoutsRecord())).toBe(false);
    expect(prepareWith(onlyTimeouts).status).toBe(75); // 成功で数え直したので、また 1 回目
  });

  it('applies the same once-per-head rule to the S3 light check (class L)', () => {
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
