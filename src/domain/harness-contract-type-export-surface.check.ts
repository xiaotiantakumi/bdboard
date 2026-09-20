// bdboard-sso1.22: harness-contract.ts を src/domain/harness-contract/*.ts へ
// モジュール分割した際の、型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は harness-contract.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` / `export type` は
// TypeScript の型のみの宣言でコンパイルすると消える (実行時のバインディングを持たない)
// ため、Object.keys() には現れずその手法では検証できない。代わりに、分割前
// (このコミット時点) の harness-contract.ts から
// `grep -nE '^export (interface|type) [A-Za-z0-9_]+' src/domain/harness-contract.ts`
// で機械的に採取した型エクスポート名 (16件) を入口 (./harness-contract.js) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す。
//
// 分割後の harness-contract.ts は名前を明示した re-export のみになる。ここが崩れる
// (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type {
  ContractState,
  HarnessContract,
  HarnessContractHooks,
  HarnessContractModels,
  HarnessContractParseFailureReason,
  HarnessModelCandidate,
  HarnessModelComplexity,
  HarnessModelComplexityKey,
  HarnessModelExclude,
  HarnessModelStageRoute,
  HarnessModelStageSummary,
  HarnessPrFlow,
  HarnessProjectFacts,
  ParseHarnessContractResult,
  VerifyPackageScripts,
  VerifyScriptRequirement,
} from './harness-contract.js';

// 全型を1箇所で「使う」ための tuple。コンパイル後は消える (実行時に影響しない)。
export type HarnessContractTypeExportSurfaceCheck = [
  ContractState,
  HarnessContract,
  HarnessContractHooks,
  HarnessContractModels,
  HarnessContractParseFailureReason,
  HarnessModelCandidate,
  HarnessModelComplexity,
  HarnessModelComplexityKey,
  HarnessModelExclude,
  HarnessModelStageRoute,
  HarnessModelStageSummary,
  HarnessPrFlow,
  HarnessProjectFacts,
  ParseHarnessContractResult,
  VerifyPackageScripts,
  VerifyScriptRequirement,
];
