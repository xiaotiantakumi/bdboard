// bdboard-sso1.42: ai-quota-source.ts を ./ai-quota-source/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function) は ai-quota-source.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys()
// には現れずその手法では検証できない。代わりに、分割前の main の ai-quota-source.ts から
// `grep -oE '^export (interface|type) [A-Za-z0-9_]+' src/infrastructure/process/ai-quota-source.ts`
// で機械的に採取した型エクスポート名 (1件) を入口 (./ai-quota-source.js) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す
// (dto.ts 分割 #540 の方式)。
//
// 分割後の ai-quota-source.ts はサブモジュールへの再エクスポートのみになった。ここが
// 崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc
// がこのファイルで落ちる (TS2305: has no exported member)。
import type { NodeAiQuotaSourceOptions } from './ai-quota-source.js';

export type ExpectedTypeExportSurface = [NodeAiQuotaSourceOptions];
