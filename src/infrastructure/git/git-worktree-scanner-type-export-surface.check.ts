// bdboard-sso1.49: git-worktree-scanner.ts を
// src/infrastructure/git/git-worktree-scanner/*.ts へモジュール分割した際の、型
// エクスポート面の回帰ガード。
//
// 値エクスポート (const/function) は git-worktree-scanner.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前の git-worktree-scanner.ts の型
// エクスポート面 (1件: `export interface` GitWorktreeScannerOptions) を入口
// (./git-worktree-scanner.js) から import し、1箇所の tuple 型で「使う」ことで
// `npm run build` (tsc --noEmit) に通す (dto.ts 分割, PR #540 / git-worktree-provisioner.ts
// 分割, PR #567 と同じ方式)。
//
// 分割後の git-worktree-scanner.ts はこれを直接宣言するだけの入口になる。ここが崩れる
// (型の移し忘れ・名前の変更) と、import 自体が解決できず tsc がこのファイルで落ちる
// (TS2305: has no exported member)。
import type { GitWorktreeScannerOptions } from './git-worktree-scanner.js';

export type GitWorktreeScannerTypeExportSurfaceCheck = [GitWorktreeScannerOptions];
