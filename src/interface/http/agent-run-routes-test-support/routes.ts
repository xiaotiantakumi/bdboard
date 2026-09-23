// bdboard-sso1.81: agent-run-routes-test-support.ts のモジュール分割 (move only) で
// 切り出した、他の関心別モジュールを束ねて agent-run ルートを組み立てる工場置き場。
import { createRunStore } from '../../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../../application/runner/runner-registry.js';
import { createAgentRunRoutes } from '../agent-run-routes.js';
import { createFakeBoardCache } from './board-cache.js';
import { NOW } from './constants.js';
import { readyHarnessStatus } from './harness-status.js';
import { makeIssueWriter, makeProvisioner } from './run-deps.js';

export function makeRoutes(deps: Partial<Parameters<typeof createAgentRunRoutes>[0]> = {}) {
  const cache = deps.cache ?? createFakeBoardCache();
  const registry = deps.registry ?? createAgentRunnerRegistry();
  const runStore = deps.runStore ?? createRunStore({ now: () => NOW });
  const worktreeProvisioner = deps.worktreeProvisioner ?? makeProvisioner();
  const issueWriter = deps.issueWriter ?? makeIssueWriter();

  const app = createAgentRunRoutes({
    cache,
    registry,
    runStore,
    worktreeProvisioner,
    // normalizePath は必須依存。正規化を要らないテストは恒等関数を明示的に渡す。
    normalizePath: deps.normalizePath ?? ((pathValue: string) => pathValue),
    writeAccess: deps.writeAccess,
    getHarnessStatus: deps.getHarnessStatus ?? (async () => readyHarnessStatus()),
    isRemoteAgentRunAllowed: deps.isRemoteAgentRunAllowed ?? (async () => true),
    now: deps.now ?? (() => NOW),
    issueWriter,
    ...deps,
  });

  return { app, cache, registry, runStore, worktreeProvisioner, issueWriter };
}
