// bdboard-sso1.64: tunnel-service.ts を ./tunnel-service/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (function/const) は tunnel-service.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export interface` / `export type` は
// TypeScript の型のみの宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、
// Object.keys() には現れずその手法では検証できない。代わりに、分割前の origin/main の
// tunnel-service.ts から
// `grep -oE '^export (interface|type) [A-Za-z0-9_]+' src/application/tunnel/tunnel-service.ts`
// で機械的に採取した型エクスポート名 (3件) を入口 (./tunnel-service.js) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す
// (cloudflared-tunnel.ts 分割 #617 / basic-auth.ts 分割 #622 の方式)。
//
// 分割後の tunnel-service.ts は createTunnelService() 本体 + サブモジュールへの
// 再エクスポートになった。ここが崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、
// import 自体が解決できず tsc がこのファイルで落ちる (TS2305: has no exported member)。
import type { TunnelState, TunnelServiceDeps, TunnelService } from './tunnel-service.js';

export type ExpectedTypeExportSurface = [TunnelState, TunnelServiceDeps, TunnelService];
