// bdboard-sso1.47: ps-process-scanner.ts を ./ps-process-scanner/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function) は ps-process-scanner.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys()
// には現れずその手法では検証できない。代わりに、分割前の main の ps-process-scanner.ts から
// `grep -oE '^export (interface|type) [A-Za-z0-9_]+' src/infrastructure/process/ps-process-scanner.ts`
// で機械的に採取した型エクスポート名 (1件) を入口 (./ps-process-scanner.js) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す
// (ai-quota-source.ts 分割 #605 の方式)。
//
// 分割後の ps-process-scanner.ts はサブモジュールへの再エクスポートのみになった。ここが
// 崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc
// がこのファイルで落ちる (TS2305: has no exported member)。
import type { PsProcessScannerOptions } from './ps-process-scanner.js';

export type ExpectedTypeExportSurface = [PsProcessScannerOptions];
