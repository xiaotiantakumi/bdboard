// bdboard-sso1.16: bd-cli-human-decisions.ts を src/infrastructure/bd/bd-cli-human-decisions/*.ts
// へモジュール分割した際の、型エクスポート面の回帰ガード。
//
// 値エクスポート (class/function/const) は bd-cli-human-decisions.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export type { ... }` の再エクスポートと
// `export interface` は TypeScript の型のみの宣言でコンパイルすると消える (実行時の
// バインディングを持たない) ため、Object.keys() には現れずその手法では検証できない。
// 代わりに、分割前の bd-cli-human-decisions.ts の型エクスポート面 (5件: `export type { ... }`
// で再エクスポートしている4件 + このファイル自身が宣言する `export interface`
// BdCliHumanDecisionsOptions) を入口 (./bd-cli-human-decisions.js) からまとめて import し、
// 1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す (dto.ts 分割,
// PR #540 と同じ方式)。
//
// 分割後の bd-cli-human-decisions.ts はこれらを re-export するだけの入口になった。ここが
// 崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type {
  BdCliHumanDecisionsOptions,
  HumanDecisionsPort,
  PendingDecision,
  PendingDecisionOption,
  RespondOutcome,
} from './bd-cli-human-decisions.js';

export type BdCliHumanDecisionsTypeExportSurfaceCheck = [
  BdCliHumanDecisionsOptions,
  HumanDecisionsPort,
  PendingDecision,
  PendingDecisionOption,
  RespondOutcome,
];
