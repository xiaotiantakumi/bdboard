import { describe, expect, it } from 'vitest';
import * as nextUpRunLoop from './nextUpRunLoop';

/**
 * bdboard-sso1.50: web/src/components/nextUpRunLoop.ts を機能別モジュール
 * (./next-up/run-loop/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の nextUpRunLoop.ts) から
 * `grep -nE '^export ' web/src/components/nextUpRunLoop.ts` で機械的に採取した
 * 値エクスポート名をそのままハードコードしている (ps-process-scanner.ts 分割 #611 の方式)。
 *
 * 型エクスポート (`export type` / `export interface`) はここでは検証できないため、
 * nextUpRunLoop-type-export-surface.check.ts (dto.ts 分割 #540 の方式) を別途置く。
 */
const EXPECTED_VALUE_EXPORTS = [
  'INITIAL_NEXT_UP_LOOP_PROGRESS',
  'NEXT_UP_LOOP_COMMENT_POST_TIMEOUT_MS',
  'NEXT_UP_LOOP_MAX_CONSECUTIVE_FAILURES',
  'NEXT_UP_LOOP_POLL_MAX_DELAY_MS',
  'NEXT_UP_LOOP_POLL_MAX_FAILURES',
  'buildConsecutiveFailureComment',
  'createTicketRunsInvalidator',
  'describeConsecutiveFailureStop',
  'describePollFailureError',
  'isAgentRunTerminal',
  'nextUpLoopPollDelayMs',
  'runNextUpTicketLoop',
  'useNextUpRunLoopController',
  'waitForAgentRunTerminal',
].sort();

describe('nextUpRunLoop.ts export surface (bdboard-sso1.50 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(nextUpRunLoop).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
