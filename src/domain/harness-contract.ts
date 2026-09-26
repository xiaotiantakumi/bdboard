// src/domain/harness-contract.ts は bdboard-sso1.22 でモジュール分割された。実体は
// ./harness-contract/ 配下。このファイルは import 側 (routes・application 層・テスト)
// を書き換えないための re-export 入口としてのみ残す。挙動・型は一切変えていない
// (移動のみ)。
//
// 分割前は多くのパース補助関数 (isPlainObject / isSafeSingleLineValue /
// parseModels 等) が同じファイル内の非公開関数だった。分割後はサブモジュール間の
// cross-module import のために export を付けているものがあるが、ここで `export *` を
// 使うと元は非公開だった補助関数まで公開エクスポート面に漏れてしまう。よって公開面は
// 分割前の export 一覧のとおり名前を明示して re-export する (hygiene.ts の分割
// (PR #556) / dto.ts の分割 (PR #540) と同じ方式。回帰ガードは
// harness-contract.exportSurface.test.ts / harness-contract-type-export-surface.check.ts)。
export {
  HARNESS_CONTRACT_RELATIVE_PATH,
  HARNESS_CONTRACT_VERSION,
  DEFAULT_MAIN_BRANCH,
  HARNESS_PR_FLOWS,
  HARNESS_MODEL_COMPLEXITIES,
  HARNESS_MODEL_WILDCARD,
} from './harness-contract/types.js';
export type {
  HarnessPrFlow,
  HarnessModelComplexity,
  HarnessModelCandidate,
  HarnessModelComplexityKey,
  HarnessModelStageRoute,
  HarnessModelExclude,
  HarnessContractModels,
  HarnessModelStageSummary,
  HarnessContract,
  HarnessContractParseFailureReason,
  ParseHarnessContractResult,
  ContractState,
  VerifyPackageScripts,
  HarnessProjectFacts,
} from './harness-contract/types.js';

export { isSafeMainBranchName } from './harness-contract/main-branch.js';

export {
  countExpiredModelExcludes,
  computeModelExclusionWarnings,
} from './harness-contract/model-exclude.js';
export { summarizeHarnessModels } from './harness-contract/model-routes.js';

export { parseHarnessContract } from './harness-contract/parse.js';

export type { VerifyScriptRequirement } from './harness-contract/verify-script.js';
export { resolveVerifyScriptRequirement } from './harness-contract/verify-script.js';

export { evaluateContractState } from './harness-contract/state.js';
