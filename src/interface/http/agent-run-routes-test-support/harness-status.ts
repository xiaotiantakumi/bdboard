// bdboard-sso1.81: agent-run-routes-test-support.ts のモジュール分割 (move only) で
// 切り出した、ハーネス状態 (preflight) のテスト用フィクスチャ置き場。
import type { ContractState } from '../../../domain/harness-contract.js';
import type {
  ProjectHarnessPackStatus,
  ProjectHarnessStatus,
} from '../../../domain/harness-pack.js';
import { RUN_REQUIRED_PACK_NAME } from '../../../domain/harness-run-preflight.js';

export const READY_CONTRACT: ContractState = {
  state: 'ok',
  verify: 'npm run verify',
  prFlow: 'pr',
  mainBranch: 'main',
  models: null,
  expiredExcludeCount: 0,
  modelExclusionWarnings: [],
};

export function harnessPack(
  overrides: Partial<ProjectHarnessPackStatus> = {},
): ProjectHarnessPackStatus {
  return {
    name: RUN_REQUIRED_PACK_NAME,
    availableVersion: '1.0.0',
    installedVersion: '1.0.0',
    drift: false,
    hooksState: 'ok',
    missingHooks: [],
    ...overrides,
  };
}

/**
 * preflight を満たすハーネス状態 (bdboard-pkr6.11)。既定でこれを返すのは、
 * preflight 以外のテストが「前提は揃っている」前提で書かれているため。
 * preflight そのものを見るテストだけが `getHarnessStatus` を差し替える。
 */
export function readyHarnessStatus(
  packOverrides: Partial<ProjectHarnessPackStatus> = {},
  contract: ContractState = READY_CONTRACT,
): ProjectHarnessStatus {
  return { packs: [harnessPack(packOverrides)], contract };
}
