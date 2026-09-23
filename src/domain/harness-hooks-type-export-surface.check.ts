// bdboard-sso1.66: harness-hooks.ts を src/domain/harness-hooks/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は harness-hooks.exportSurface.test.ts が `Object.keys()` で
// 実行時に検証できるが、`export interface` / `export type` は TypeScript の型のみの宣言で
// コンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前 (このコミット時点) の harness-hooks.ts から
// `grep -nE '^export (interface|type) [A-Za-z0-9_]+' src/domain/harness-hooks.ts`
// で機械的に採取した型エクスポート名 (5件) を入口 (./harness-hooks.js) からまとめて import し、
// 1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す。
//
// 分割後の harness-hooks.ts は名前を明示した re-export のみになる。ここが崩れる (型の移し忘れ・
// 名前の変更・re-export の欠落) と、import 自体が解決できず tsc がこのファイルで落ちる
// (TS2305: has no exported member)。
import type {
  HarnessHookPack,
  HarnessHooksEvaluation,
  HarnessHooksState,
  MergeHarnessHooksResult,
  PackHookDeclaration,
} from './harness-hooks.js';

// 全型を1箇所で「使う」ための tuple。コンパイル後は消える (実行時に影響しない)。
export type HarnessHooksTypeExportSurfaceCheck = [
  HarnessHookPack,
  HarnessHooksEvaluation,
  HarnessHooksState,
  MergeHarnessHooksResult,
  PackHookDeclaration,
];
