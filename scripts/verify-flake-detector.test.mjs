// bdboard-8rl8: classifyVerifyOutput() の両方向を固定する。
//
// (a) 実失敗 0 件 + onTaskUpdate タイムアウト → 'known-flake'
// (b) 実失敗が 1 件以上ある場合、onTaskUpdate が同居していても 'real-failure'
//     (取り違えると実バグを握り潰す最悪の挙動になる — これがこのチケットの本体)
//
// 加えて、安全側フォールバック (書式変更で "Tests" サマリ行が見つからない場合は
// 'undetermined' であって 'known-flake' ではないこと) も固定する。
import { describe, expect, it } from 'vitest';

import {
  classifyVerifyOutput,
  formatKnownFlakeNotice,
  ON_TASK_UPDATE_TIMEOUT_SIGNATURE,
  stripAnsi,
} from './verify-flake-detector.mjs';

// bdboard-c6nv の実測ログに基づく最小再現。
const ON_TASK_UPDATE_ERROR_BLOCK = [
  '',
  ' ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
  'Vitest caught 1 unhandled error during the test run. This might cause false',
  'positive tests. Resolve unhandled errors to make sure your tests are not',
  'affected.',
  '',
  `Error: [vitest-worker]: ${ON_TASK_UPDATE_TIMEOUT_SIGNATURE}`,
  '',
  ' ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
  '',
].join('\n');

const passingServerRunOutput = [
  ' Test Files  237 passed | 2 skipped (239)',
  '      Tests  3299 passed | 85 skipped (3384)',
  '   Start at  10:03:12',
  '   Duration  42.11s',
  '',
  ON_TASK_UPDATE_ERROR_BLOCK,
  '',
  ' Errors  1 error',
  '',
  'Process completed with exit code 1',
].join('\n');

// bdboard-6y5b の実例: per-test timeout の実失敗と onTaskUpdate が同居。
const realFailureWithOnTaskUpdateOutput = [
  ' Test Files  1 failed | 236 passed | 2 skipped (239)',
  '      Tests  1 failed | 3300 passed | 85 skipped (3384)',
  '',
  ' FAIL  scripts/check-drift.test.mjs > recognizes a conflict on a non-ASCII path',
  '   Test timed out in 15000ms.',
  '',
  ON_TASK_UPDATE_ERROR_BLOCK,
  '',
  ' Errors  1 error',
  '',
  'Process completed with exit code 1',
].join('\n');

const cleanFailureOutput = [
  ' Test Files  1 failed | 238 passed (239)',
  '      Tests  1 failed | 3383 passed | 85 skipped (3384)',
  '',
  ' FAIL  src/some-module.test.ts > does the thing',
].join('\n');

const tscBuildFailureOutput = [
  'src/domain/board.ts(42,7): error TS2322: Type "string" is not assignable to type "number".',
  '',
  'npm ERR! code 2',
].join('\n');

describe('classifyVerifyOutput', () => {
  it('(a) known flake: 0 real failures + onTaskUpdate timeout -> known-flake', () => {
    const result = classifyVerifyOutput(passingServerRunOutput);
    expect(result.status).toBe('known-flake');
    expect(result.failedCount).toBe(0);
    expect(result.hasOnTaskUpdateTimeout).toBe(true);
  });

  it('(b) real failure takes priority even when onTaskUpdate is present alongside it', () => {
    const result = classifyVerifyOutput(realFailureWithOnTaskUpdateOutput);
    expect(result.status).toBe('real-failure');
    expect(result.status).not.toBe('known-flake');
    expect(result.failedCount).toBe(1);
    expect(result.hasOnTaskUpdateTimeout).toBe(true);
  });

  it('sums failed counts across multiple "Tests" summary lines (test:server + test:web both ran)', () => {
    const combined = `${realFailureWithOnTaskUpdateOutput}\n\n Tests  2 failed | 100 passed (102)`;
    const result = classifyVerifyOutput(combined);
    expect(result.status).toBe('real-failure');
    expect(result.failedCount).toBe(3);
  });

  it('a real failure with no onTaskUpdate timeout is still real-failure, not known-flake', () => {
    const result = classifyVerifyOutput(cleanFailureOutput);
    expect(result.status).toBe('real-failure');
    expect(result.failedCount).toBe(1);
    expect(result.hasOnTaskUpdateTimeout).toBe(false);
  });

  it('0 failures with no onTaskUpdate timeout is "other", not known-flake', () => {
    const result = classifyVerifyOutput(' Tests  3394 passed | 1 skipped (3395)');
    expect(result.status).toBe('other');
    expect(result.failedCount).toBe(0);
    expect(result.hasOnTaskUpdateTimeout).toBe(false);
  });

  it('does not mistake the "Test Files" summary line for the "Tests" line', () => {
    // "Test Files" 行だけの (壊れた/部分的な) 出力では "Tests" サマリが無いので undetermined。
    const result = classifyVerifyOutput(' Test Files  1 failed | 236 passed (237)');
    expect(result.status).toBe('undetermined');
  });

  it('falls back to "undetermined" (never "known-flake") when no "Tests" summary line is found at all', () => {
    // tsc のビルド失敗など、vitest が走らなかった/出力書式が変わったケースの安全側フォールバック。
    const result = classifyVerifyOutput(tscBuildFailureOutput);
    expect(result.status).toBe('undetermined');
    expect(result.failedCount).toBeNull();
  });

  it('treats empty or non-string input as undetermined without throwing', () => {
    expect(classifyVerifyOutput('').status).toBe('undetermined');
    expect(classifyVerifyOutput(undefined).status).toBe('undetermined');
  });
});

// verify.mjs は TTY のとき FORCE_COLOR=1 を子に渡す。そのとき vitest のサマリ行は
// 行頭の空白より**前**に `\u001B[2m` が付いた形で来る。下は実測したバイト列そのまま。
// ANSI を除去しないと `^[ \t]*Tests` が一致せず summaryLines が 0 件になり、
// ローカル (= このチケットが対象にしている macOS 手元実行) だけ黙って
// 'undetermined' に落ちる。CI は非TTYで色が付かないので通ってしまい、
// 一番効いてほしい環境でだけ機能が死ぬ、という非対称な壊れ方をする。
const ANSI_TESTS_SUMMARY_LINE =
  '\u001B[2m      Tests \u001B[22m \u001B[1m\u001B[32m9 passed\u001B[39m\u001B[22m\u001B[90m (9)\u001B[39m';

describe('classifyVerifyOutput with ANSI-coloured output (FORCE_COLOR)', () => {
  it('strips ANSI so the Tests summary line is still found', () => {
    const result = classifyVerifyOutput(ANSI_TESTS_SUMMARY_LINE);
    expect(
      result.summaryLineCount,
      'ANSI 付きサマリ行が 1 件として数えられること (0 なら strip が効いていない)',
    ).toBe(1);
    expect(result.status).not.toBe('undetermined');
  });

  it('classifies a coloured known-flake run as known-flake, not undetermined', () => {
    const output = [ANSI_TESTS_SUMMARY_LINE, ON_TASK_UPDATE_ERROR_BLOCK].join('\n');
    const result = classifyVerifyOutput(output);
    expect(result.status).toBe('known-flake');
    expect(result.failedCount).toBe(0);
    expect(result.hasOnTaskUpdateTimeout).toBe(true);
  });

  it('still counts failures when the failed summary line is coloured', () => {
    const colouredFailure =
      '\u001B[2m      Tests \u001B[22m \u001B[1m\u001B[31m2 failed\u001B[39m | 7 passed\u001B[22m';
    const output = [colouredFailure, ON_TASK_UPDATE_ERROR_BLOCK].join('\n');
    const result = classifyVerifyOutput(output);
    expect(
      result.status,
      '実失敗は色が付いていても known-flake に握り潰されないこと',
    ).toBe('real-failure');
    expect(result.failedCount).toBe(2);
  });
});

describe('stripAnsi', () => {
  it('removes CSI sequences and leaves the payload intact', () => {
    expect(stripAnsi(ANSI_TESTS_SUMMARY_LINE)).toBe('      Tests  9 passed (9)');
  });

  it('is a no-op for text that has no escapes', () => {
    expect(stripAnsi('      Tests  9 passed (9)')).toBe('      Tests  9 passed (9)');
  });
});

describe('formatKnownFlakeNotice', () => {
  it('references bdboard-c6nv and does not claim the exit code was changed', () => {
    const classification = classifyVerifyOutput(passingServerRunOutput);
    const notice = formatKnownFlakeNotice(classification);
    expect(notice).toContain('bdboard-c6nv');
    expect(notice).toContain(ON_TASK_UPDATE_TIMEOUT_SIGNATURE);
    expect(notice).toMatch(/終了コード|exit code/);
  });
});
