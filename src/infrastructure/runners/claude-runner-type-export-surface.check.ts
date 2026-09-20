// bdboard-sso1.29: claude-runner.ts を
// src/infrastructure/runners/claude-runner/*.ts へモジュール分割した際の、型
// エクスポート面の回帰ガード。
//
// 値エクスポート (const/function) は claude-runner.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys() には
// 現れずその手法では検証できない。代わりに、分割前の claude-runner.ts の型
// エクスポート面 (1件: `export interface` ClaudeRunnerOptions) を入口
// (./claude-runner.js) から import し、1箇所の tuple 型で「使う」ことで
// `npm run build` (tsc --noEmit) に通す (dto.ts 分割, PR #540 /
// git-worktree-provisioner.ts 分割, PR #567 と同じ方式)。
//
// 分割後の claude-runner.ts はこれを re-export するだけの入口になる。ここが崩れる
// (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc が
// このファイルで落ちる (TS2305: has no exported member)。
import type { ClaudeRunnerOptions } from './claude-runner.js';

export type ClaudeRunnerTypeExportSurfaceCheck = [ClaudeRunnerOptions];
