import { describe, expect, it } from 'vitest';
import * as agentRunRoutesTestSupport from './agent-run-routes-test-support.js';

/**
 * bdboard-sso1.81: src/interface/http/agent-run-routes-test-support.ts を機能別モジュール
 * (./agent-run-routes-test-support/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の agent-run-routes-test-support.ts) から
 * `grep -oE '^export (class|function|async function|const) [A-Za-z0-9_]+' src/interface/http/agent-run-routes-test-support.ts`
 * で機械的に採取した値エクスポート名 (21件) をそのままハードコードしている
 * (ps-process-scanner.ts 分割 #611 / dto.ts 分割 #540 の方式)。
 *
 * 分割前の agent-run-routes-test-support.ts に `export interface` / `export type` は
 * 無いため、型エクスポート面の回帰ガード (dto-type-export-surface.check.ts 相当) は不要。
 *
 * 分割後の agent-run-routes-test-support.ts は `export * from
 * './agent-run-routes-test-support/xxx'` の再エクスポート入口のみになった。ここが崩れる
 * (関数の移し忘れ・名前の変更・re-export の欠落) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'CF_HEADER',
  'DEFAULT_REPO_ROOT',
  'LOCAL_ENV',
  'LOCAL_HOST',
  'NOW',
  'READY_CONTRACT',
  'SESSION_COOKIE',
  'allowingWriteAccess',
  'createFakeBoardCache',
  'harnessPack',
  'makeIssueWriter',
  'makeProvisioner',
  'makeRoutes',
  'makeRunner',
  'managedWorktreePath',
  'postRunsInit',
  'project',
  'readyHarnessStatus',
  'seedOpenTicket',
  'withLocalHost',
  'withRemoteTunnel',
].sort();

describe('agent-run-routes-test-support.ts export surface (bdboard-sso1.81 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(agentRunRoutesTestSupport).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
