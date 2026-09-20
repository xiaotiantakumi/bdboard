// bdboard-sso1.15: hygiene.ts を src/domain/hygiene/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は hygiene.exportSurface.test.ts が `Object.keys()` で
// 実行時に検証できるが、`export interface` / `export type` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前 (コミット c7b1781、PR #552 マージ直後)
// の hygiene.ts から `grep -oE '^export (interface|type) [A-Za-z0-9_]+' src/domain/hygiene.ts`
// および `HygieneThresholds` / `HygieneThresholdsOverrides` の type re-export で機械的に
// 採取した型エクスポート名 (11件) を入口 (./hygiene.js) からまとめて import し、
// 1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す。
//
// 分割後の hygiene.ts は名前を明示した re-export のみになった。ここが崩れる (型の
// 移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc がこの
// ファイルで落ちる (TS2305: has no exported member)。
import type {
  DependencyCycle,
  HarnessWorktreeLag,
  HeartbeatLoopCandidate,
  HygieneCleanupTarget,
  HygieneCycleEdge,
  HygieneHeartbeatLoopTarget,
  HygieneIssue,
  HygieneIssueKind,
  HygieneOverlapPeer,
  HygieneThresholds,
  HygieneThresholdsOverrides,
} from './hygiene.js';

// 全型を1箇所で「使う」ための tuple。コンパイル後は消える (実行時に影響しない)。
export type HygieneTypeExportSurfaceCheck = [
  DependencyCycle,
  HarnessWorktreeLag,
  HeartbeatLoopCandidate,
  HygieneCleanupTarget,
  HygieneCycleEdge,
  HygieneHeartbeatLoopTarget,
  HygieneIssue,
  HygieneIssueKind,
  HygieneOverlapPeer,
  HygieneThresholds,
  HygieneThresholdsOverrides,
];
