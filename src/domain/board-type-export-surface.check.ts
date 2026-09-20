// bdboard-sso1.34: board.ts を src/domain/board/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は board.exportSurface.test.ts が `Object.keys()` で
// 実行時に検証できるが、`export interface` / `export type` は TypeScript の型のみの宣言で
// コンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前 (このコミット時点) の board.ts から
// `grep -nE '^export (interface|type) [A-Za-z0-9_]+' src/domain/board.ts`
// で機械的に採取した型エクスポート名 (3件) を入口 (./board.js) からまとめて import し、
// 1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す。
//
// 分割後の board.ts は名前を明示した re-export のみになる。ここが崩れる (型の移し忘れ・
// 名前の変更・re-export の欠落) と、import 自体が解決できず tsc がこのファイルで落ちる
// (TS2305: has no exported member)。
import type { Board, BoardCard, BuildBoardInput } from './board.js';

// 全型を1箇所で「使う」ための tuple。コンパイル後は消える (実行時に影響しない)。
export type BoardTypeExportSurfaceCheck = [Board, BoardCard, BuildBoardInput];
