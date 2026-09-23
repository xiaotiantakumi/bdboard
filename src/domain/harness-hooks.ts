// src/domain/harness-hooks.ts は bdboard-sso1.66 でモジュール分割された。実体は
// ./harness-hooks/ 配下。このファイルは import 側 (application/harness・domain/harness-pack・
// domain/harness-run-preflight・infrastructure/harness/* 等) を書き換えないための
// re-export 入口としてのみ残す。挙動・型は一切変えていない (移動のみ)。
//
// `export *` を使うと cross-module 専用に export した非公開ヘルパー (resolveHooks /
// ResolvedHook / isPlainObject / HOOKS_KEY / COMMAND_HOOK_TYPE / JsonObject) まで公開
// エクスポート面に漏れてしまう。よって公開面は分割前の export 一覧のとおり名前を明示して
// re-export する (harness-contract.ts の分割 (PR #568) / board.ts の分割 (PR #595) /
// harness-kpi.ts の分割 (PR #615) と同じ方式。回帰ガードは harness-hooks.exportSurface.test.ts /
// harness-hooks-type-export-surface.check.ts)。
export {
  SETTINGS_RELATIVE_PATH,
  CLAUDE_PROJECT_DIR_PLACEHOLDER,
  DEFAULT_PACK_HOOK_TIMEOUT_SECONDS,
  PACK_HOOKS_DIR,
} from './harness-hooks/types.js';
export type {
  PackHookDeclaration,
  HarnessHookPack,
  HarnessHooksState,
  HarnessHooksEvaluation,
  MergeHarnessHooksResult,
} from './harness-hooks/types.js';

export { harnessHookMarker, harnessHookCommand } from './harness-hooks/command.js';

export { mergeHarnessHooks } from './harness-hooks/merge.js';

export { evaluateHooksState } from './harness-hooks/evaluate.js';
