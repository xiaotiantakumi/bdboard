// bdboard-sso1.32: run-store.ts を src/application/runner/run-store/*.ts へ
// モジュール分割した際の、型エクスポート面の回帰ガード。
//
// 値エクスポート (const/function) は run-store.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` / `export type` は
// TypeScript の型のみの宣言でコンパイルすると消える (実行時のバインディングを持たない)
// ため、Object.keys() には現れずその手法では検証できない。代わりに、分割前の
// run-store.ts の型エクスポート面 (6件: RunStoreStartEntry / RunStoreRecord /
// RunStoreListFilter / RunStoreCanStartResult / RunStore / RunStoreOptions) を入口
// (./run-store.js) から import し、1箇所の tuple 型で「使う」ことで
// `npm run build` (tsc --noEmit) に通す (dto.ts 分割, PR #540 /
// claude-runner.ts 分割, PR #580 と同じ方式)。
//
// 分割後の run-store.ts はこれを re-export するだけの入口になる。ここが崩れる
// (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type {
  RunStore,
  RunStoreCanStartResult,
  RunStoreListFilter,
  RunStoreOptions,
  RunStoreRecord,
  RunStoreStartEntry,
} from './run-store.js';

export type RunStoreTypeExportSurfaceCheck = [
  RunStoreStartEntry,
  RunStoreRecord,
  RunStoreListFilter,
  RunStoreCanStartResult,
  RunStore,
  RunStoreOptions,
];
