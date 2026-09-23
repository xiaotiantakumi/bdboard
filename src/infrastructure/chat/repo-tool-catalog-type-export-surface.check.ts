// bdboard-sso1.71: repo-tool-catalog.ts を ./repo-tool-catalog/*.ts へモジュール分割した際の、
// 型エクスポート面の回帰ガード。
//
// 値エクスポート (const/function) は repo-tool-catalog.exportSurface.test.ts が
// `Object.keys()` で実行時に検証できるが、`export type` は TypeScript の型のみの
// 宣言でコンパイルすると消える (実行時のバインディングを持たない) ため、Object.keys()
// には現れずその手法では検証できない。代わりに、分割前の main の repo-tool-catalog.ts から
// `grep -oE '^export type [A-Za-z0-9_]+' src/infrastructure/chat/repo-tool-catalog.ts`
// で機械的に採取した型エクスポート名 (3件) を入口 (./repo-tool-catalog.js) からまとめて
// import し、1箇所の tuple 型で「使う」ことで `npm run build` (tsc --noEmit) に通す
// (dto.ts 分割 #540 / ai-quota-source.ts 分割 #605 の方式)。
//
// 分割後の repo-tool-catalog.ts はサブモジュールへの再エクスポートのみになった。ここが
// 崩れる (型の移し忘れ・名前の変更・re-export の欠落) と、import 自体が解決できず tsc
// がこのファイルで落ちる (TS2305: has no exported member)。
import type {
  RepoToolName,
  RepoOutputFilter,
  RepoArgsBuildResult,
} from './repo-tool-catalog.js';

export type ExpectedTypeExportSurface = [RepoToolName, RepoOutputFilter, RepoArgsBuildResult];
