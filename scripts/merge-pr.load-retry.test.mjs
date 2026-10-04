// bdboard-xdk8: 着地後検証の failure が全部時間切れの形 (負荷由来) なら 1 回だけ再実行してから記録する。
// 分類器 (scripts/merge-pr/load-retry.mjs) の単体と、偽の gh / bd / npm を使った merge-pr の通しの確認。
// 偽の検証コマンドは FAKE_VERIFY_OUTPUT_FILE の中身をログに出し、FAKE_VERIFY_EXIT_SEQUENCE の順に終了する。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyVerifyFailure } from './merge-pr/load-retry.mjs';
import {
  auditText,
  mainCheckout,
  posted,
  PR,
  readFake,
  registerTempRepoHooks,
  run,
  setup,
  simulateMerge,
  tmp,
  verified,
} from './merge-pr.test-support.mjs';

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

const landedLogs = () => readdirSync(path.join(mainCheckout, '.git', 'bdboard-merge')).filter((name) => name.startsWith('landed-verify-'));

function loadRetryEnv(exits) {
  const output = path.join(tmp, 'fake-verify-output.txt');
  writeFileSync(output, vitestLog(TIMEOUTS, '2 failed | 100 passed (102)'));
  return { FAKE_VERIFY_OUTPUT_FILE: output, FAKE_VERIFY_EXIT_SEQUENCE: exits, FAKE_VERIFY_SEQUENCE_FILE: path.join(tmp, 'fake-verify-seq') };
}

describe.skipIf(process.platform === 'win32')('merge-pr finish: one retry after a load-induced landed failure (bdboard-xdk8)', { timeout: 30_000 }, () => {
  registerTempRepoHooks();

  it('records success after the retry passes, says so on the ledger, and keeps the first log', () => {
    setup();
    expect(run(['prepare', String(PR)]).status).toBe(0);
    expect(run(['gate', String(PR)]).status).toBe(0);
    const landed = simulateMerge();
    const finished = run(['finish', String(PR)], loadRetryEnv('1,0'));
    expect(finished.status, finished.stderr).toBe(0);
    expect(verified()).toHaveLength(2);
    expect(finished.stderr).toContain('負荷由来とみなし、1 回だけ再実行します');
    const states = posted().map(({ sha, state }) => [sha, state]);
    expect(states).toEqual([[landed, 'pending'], [landed, 'pending'], [landed, 'success']]);
    expect(posted().at(-1).description).toContain('retried after load-induced failure: 3 timeouts');
    expect(readFake().slot.holder).toBeNull();
    expect(auditText()).toMatch(/\tlanded-verify-retry\t.*exit=1\ttimeouts=3\t/);
    const kept = landedLogs().filter((name) => name.includes('.first-attempt-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(path.join(mainCheckout, '.git', 'bdboard-merge', kept[0]), 'utf8')).toContain('Test timed out in 5000ms');
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
    expect(landedLogs().some((name) => name.includes('.first-attempt-'))).toBe(false);
    expect(existsSync(path.join(tmp, 'fake-verify-seq'))).toBe(false);
  });
});
