// bdboard-sso1.21: git-worktree-provisioner.ts を
// src/infrastructure/git/git-worktree-provisioner/*.ts へモジュール分割した際の、型
// エクスポート面の回帰ガード。
//
// 値エクスポート (const/function) は git-worktree-provisioner.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前の git-worktree-provisioner.ts の型
// エクスポート面 (1件: `export interface` GitWorktreeProvisionerOptions) を入口
// (./git-worktree-provisioner.js) から import し、1箇所の tuple 型で「使う」ことで
// `npm run build` (tsc --noEmit) に通す (dto.ts 分割, PR #540 / bd-cli-human-decisions.ts
// 分割, PR #555 と同じ方式)。
//
// 分割後の git-worktree-provisioner.ts はこれを re-export (または直接宣言) するだけの
// 入口になる。ここが崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が
// 解決できず tsc がこのファイルで落ちる (TS2305: has no exported member)。
import type { GitWorktreeProvisionerOptions } from './git-worktree-provisioner.js';

export type GitWorktreeProvisionerTypeExportSurfaceCheck = [GitWorktreeProvisionerOptions];
