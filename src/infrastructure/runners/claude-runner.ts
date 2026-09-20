// Claude runners launch via StreamingCommandRunner when one is passed; without it they
// return a dispatch-disabled outcome instead of spawning. The composition root
// (src/main.ts) wires the spawn runner with a streaming runner, reachable only via
// POST /api/runs behind agent-run-guard.
//
// bdboard-sso1.29: 455行 (ESLint 有効行) だったこのファイルを、関心別に
// ./claude-runner/*.ts へ move-only で分割した。ここは合成/re-export のみの入口。
// 手本: git-worktree-provisioner.ts (PR #567) / agent-run-routes.ts (PR #576)。
export {
  resetClaudeVersionCacheForTests,
} from './claude-runner/version-probe.js';
export {
  ALLOWED_BASH_WILDCARD_VERBS,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_SETTING_SOURCES,
  DENIED_TOOLS,
} from './claude-runner/permission-policy.js';
export type { ClaudeRunnerOptions } from './claude-runner/options.js';
export {
  clearWorktreeLocalClaudeSettings,
} from './claude-runner/worktree-settings-cleanup.js';
export { buildRunnerEnv } from './claude-runner/runner-env.js';
export { createClaudeRunner } from './claude-runner/create-claude-runner.js';
