// bdboard-sso1.55: useHygieneRepairActions.ts を ./repair-actions/*.ts へ
// モジュール分割した際の、型エクスポート面の回帰ガード。
//
// 値エクスポート (function) は useHygieneRepairActions.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の
// 型のみの宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、
// Object.keys() には現れずその手法では検証できない。代わりに、分割前の main の
// useHygieneRepairActions.ts から
// `grep -oE '^export (interface|type) [A-Za-z0-9_]+' web/src/components/hygiene/useHygieneRepairActions.ts`
// で機械的に採取した型エクスポート名を入口 (./useHygieneRepairActions) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build:web` (tsc --noEmit) に通す
// (nextUpRunLoop.ts 分割 #614 / ps-process-scanner.ts 分割 #611 の方式)。
//
// 分割後の useHygieneRepairActions.ts は関心別フックを呼び出して束ねる配線のみに
// なった。ここが崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が
// 解決できず tsc がこのファイルで落ちる (TS2305: has no exported member)。
import type { HygieneRepairActions } from './useHygieneRepairActions';

export type ExpectedTypeExportSurface = [HygieneRepairActions];
