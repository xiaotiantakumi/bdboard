// bdboard-sso1.54: cloudflared-tunnel.ts を ./cloudflared-tunnel/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は cloudflared-tunnel.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` / `export type` は
// TypeScript の型のみの宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、
// Object.keys() には現れずその手法では検証できない。代わりに、分割前の main の
// cloudflared-tunnel.ts から
// `grep -oE '^export (interface|type) [A-Za-z0-9_]+' src/infrastructure/process/cloudflared-tunnel.ts`
// で機械的に採取した型エクスポート名 (5件) を入口 (./cloudflared-tunnel.js) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す
// (ai-quota-source.ts 分割 #605 / ps-process-scanner.ts 分割 #611 の方式)。
//
// 分割後の cloudflared-tunnel.ts は createCloudflaredTunnel() 本体 + サブモジュールへの
// 再エクスポートになった。ここが崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、
// import 自体が解決できず tsc がこのファイルで落ちる (TS2305: has no exported member)。
import type {
  LogSink,
  DataStream,
  SpawnedProcess,
  SpawnFn,
  CloudflaredTunnelOptions,
} from './cloudflared-tunnel.js';

export type ExpectedTypeExportSurface = [
  LogSink,
  DataStream,
  SpawnedProcess,
  SpawnFn,
  CloudflaredTunnelOptions,
];
