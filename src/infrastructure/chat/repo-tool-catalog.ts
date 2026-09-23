// src/infrastructure/chat/repo-tool-catalog.ts は bdboard-sso1.71 でモジュール分割された。
// 実体は ./repo-tool-catalog/ 配下:
//   - definitions.ts   : ツール名・ツール定義 (REPO_TOOL_NAMES / RepoToolName /
//     isRepoToolName / REPO_TOOL_DEFINITIONS)
//   - schemas.ts        : 入力検証の zod スキーマ (内部専用、re-export しない)
//   - args-builder.ts   : git 引数組み立て (RepoOutputFilter / RepoArgsBuildResult /
//     REPO_DEFAULT_REF / buildRepoToolArgs)
//   - output-filter.ts  : git 出力の絞り込み (applyRepoOutputFilter)
// このファイルは import 側 (呼び出し元・テスト) を書き換えないための入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。公開面は分割前の export 一覧のとおり名前を
// 明示して re-export する (ai-quota-source.ts の分割 (PR #605) / harness-hooks.ts の
// 分割 (PR #627) と同じ方式。回帰ガードは repo-tool-catalog.exportSurface.test.ts /
// repo-tool-catalog-type-export-surface.check.ts)。
export {
  REPO_TOOL_NAMES,
  isRepoToolName,
  REPO_TOOL_DEFINITIONS,
} from './repo-tool-catalog/definitions.js';
export type { RepoToolName } from './repo-tool-catalog/definitions.js';
export {
  REPO_DEFAULT_REF,
  buildRepoToolArgs,
} from './repo-tool-catalog/args-builder.js';
export type {
  RepoOutputFilter,
  RepoArgsBuildResult,
} from './repo-tool-catalog/args-builder.js';
export { applyRepoOutputFilter } from './repo-tool-catalog/output-filter.js';
