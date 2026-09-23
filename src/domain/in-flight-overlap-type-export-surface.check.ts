// bdboard-sso1.76: in-flight-overlap.ts を src/domain/in-flight-overlap/*.ts へ
// モジュール分割した際の、型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は in-flight-overlap.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` / `export type` は
// TypeScript の型のみの宣言でコンパイルすると消える (実行時のバインディングを持たない)
// ため、Object.keys() には現れずその手法では検証できない。代わりに、分割前 (このコミット
// 時点) の in-flight-overlap.ts から
// `grep -nE '^export (interface|type) [A-Za-z0-9_]+' src/domain/in-flight-overlap.ts`
// で機械的に採取した型エクスポート名 (5件) を入口 (./in-flight-overlap.js) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す。
//
// 分割後の in-flight-overlap.ts は名前を明示した re-export のみになる。ここが崩れる
// (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type {
  InFlightFileEntry,
  InFlightOverlap,
  InFlightOverlapGroup,
  InFlightOverlapPeer,
  InFlightWorktree,
} from './in-flight-overlap.js';

// 全型を1箇所で「使う」ための tuple。コンパイル後は消える (実行時に影響しない)。
export type InFlightOverlapTypeExportSurfaceCheck = [
  InFlightFileEntry,
  InFlightOverlap,
  InFlightOverlapPeer,
  InFlightOverlapGroup,
  InFlightWorktree,
];
