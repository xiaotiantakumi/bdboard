import { describe, expect, it } from 'vitest';
import * as useTicketAgentRunModule from './useTicketAgentRun';

/**
 * bdboard-sso1.79: web/src/components/ticket-detail/useTicketAgentRun.ts を
 * 関心別フック (./agent-run/*.ts) へ分割した際の、実行時エクスポート面の
 * 回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の useTicketAgentRun.ts) から
 * `grep -nE '^export ' web/src/components/ticket-detail/useTicketAgentRun.ts` で
 * 機械的に採取した値エクスポート名をそのままハードコードしている
 * (useHygieneRepairActions.ts 分割 #618 と同じ方式)。
 *
 * このファイルには `export type` / `export interface` が無いため、型エクスポート面の
 * tsc チェックファイルは不要 (useTicketAgentRun.ts 自体は分割前から戻り値の型を
 * 明示的に export していない)。
 */
const EXPECTED_VALUE_EXPORTS = ['useTicketAgentRun'].sort();

describe('useTicketAgentRun.ts export surface (bdboard-sso1.79 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(useTicketAgentRunModule).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
