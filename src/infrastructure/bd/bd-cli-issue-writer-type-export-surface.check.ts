// bdboard-sso1.24: bd-cli-issue-writer.ts を src/infrastructure/bd/bd-cli-issue-writer/*.ts
// へモジュール分割した際の、型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は bd-cli-issue-writer.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前の bd-cli-issue-writer.ts の型エクスポート面
// (1件: このファイル自身が宣言する `export interface` BdCliIssueWriterOptions) を入口
// (./bd-cli-issue-writer.js) からまとめて import し、1箇所の tuple 型で「使う」ことで
// `npm run build` (tsc --noEmit) に通す (dto.ts 分割, PR #540 と同じ方式)。
//
// 分割後の bd-cli-issue-writer.ts はこの型を引き続き自前で宣言する (他モジュールへ移す
// 理由が無い)。ここが崩れる (型の削除・名前の変更) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type { BdCliIssueWriterOptions } from './bd-cli-issue-writer.js';

export type BdCliIssueWriterTypeExportSurfaceCheck = [BdCliIssueWriterOptions];
