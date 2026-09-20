/**
 * bdboard-sso1.14: src/main.ts (composition root) からエージェント実行
 * (agent-run) 領域の配線を切り出したもの (move only, 挙動変更ゼロ)。
 *
 * agent-run 設定ストア・ランナーレジストリ・run ストア・worktree
 * provisioner・remote 実行許可の起動時解決・ルーターの組み立てまでを担う。
 */
import type { Hono } from 'hono';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { StreamingCommandRunner } from '../application/ports/streaming-command-runner.js';
import type { IssueWriterPort } from '../application/ports/issue-writer.js';
import type { PackRegistryPort } from '../application/ports/pack-registry.js';
import type { HarnessInjectorPort } from '../application/ports/harness-injector.js';
import type { HarnessContractReaderPort } from '../application/ports/harness-contract-reader.js';
import { createFileAgentRunConfigStore } from '../infrastructure/fs/agent-run-config-store.js';
import {
  createGitWorktreeProvisioner,
  DEFAULT_MAX_MANAGED_WORKTREES,
  normalizePathForComparison,
} from '../infrastructure/git/git-worktree-provisioner.js';
import { createClaudeSpawnRunner } from '../infrastructure/runners/claude-spawn-runner.js';
import { createRunStore } from '../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../application/runner/runner-registry.js';
import { resolveAllowRemoteAgentRuns } from '../domain/agent-run-policy.js';
import { readProjectHarnessStatus } from '../application/harness/get-project-harness-status.js';
import { createAgentRunSettingsRoutes } from '../interface/http/agent-run-settings-routes.js';
import { createAgentRunRoutes } from '../interface/http/agent-run-routes.js';
import { envInt, envString } from '../infrastructure/env.js';

export interface WireAgentRunDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly configFilePath: string;
  readonly cache: BoardCache;
  readonly commandRunner: CommandRunner;
  readonly streamingCommandRunner: StreamingCommandRunner;
  readonly ghPath: string;
  readonly writeAccess: WriteGuardDeps;
  readonly issueWriter: IssueWriterPort;
  readonly packRegistry: PackRegistryPort;
  readonly harnessInjector: HarnessInjectorPort;
  readonly harnessContractReader: HarnessContractReaderPort;
  readonly log?: (message: string) => void;
  readonly logWarn?: (message: string, err: unknown) => void;
}

export async function wireAgentRun(
  deps: WireAgentRunDeps,
): Promise<{ agentRunSettingsRouter: Hono; agentRunRouter: Hono; runStore: ReturnType<typeof createRunStore> }> {
  const log = deps.log ?? console.log;
  const logWarn = deps.logWarn ?? ((message, err) => console.warn(message, err));

  const agentRunConfigStore = createFileAgentRunConfigStore(
    envString(deps.env, 'BDBOARD_AGENT_RUN_CONFIG_PATH', deps.configFilePath),
  );
  const agentRunSettingsRouter = createAgentRunSettingsRoutes({
    store: agentRunConfigStore,
    writeAccess: deps.writeAccess,
  });

  const agentRunRegistry = createAgentRunnerRegistry();
  agentRunRegistry.register(
    createClaudeSpawnRunner({ streamingRunner: deps.streamingCommandRunner }),
  );
  const runStore = createRunStore({
    // Keep in sync with run-store DEFAULT_MAX_CONCURRENT: verify uses two slots per
    // machine, and each run prompt drives npm run verify.
    maxConcurrent: envInt(deps.env, 'BDBOARD_MAX_CONCURRENT_RUNS', 1),
    now: () => new Date(),
  });
  const worktreeProvisioner = createGitWorktreeProvisioner({
    commandRunner: deps.commandRunner,
    ghPath: deps.ghPath,
    maxManagedWorktrees: envInt(
      deps.env,
      'BDBOARD_MAX_MANAGED_WORKTREES',
      DEFAULT_MAX_MANAGED_WORKTREES,
    ),
  });

  // bdboard-54be.1: allowRemoteAgentRuns は起動時に一度だけ読み、リクエスト毎に config を
  // 再読み込みしない。実行中のエージェントが config ファイルを書き換えた瞬間にリモート実行が
  // 有効化される権限昇格経路（confused deputy）になるため。変更を反映するにはサーバー再起動が
  // 必要 — UX（即時反映）より安全側を取る裁定済みのトレードオフ。ここをリクエスト毎の再読み込み
  // に戻さないこと。
  const remoteAgentRunsAllowed = await (async (): Promise<boolean> => {
    try {
      return resolveAllowRemoteAgentRuns(await agentRunConfigStore.read());
    } catch (err) {
      logWarn('bdboard: failed to read agent run config for startup log', err);
      return false;
    }
  })();
  log(`Agent runs: enabled (remote: ${remoteAgentRunsAllowed ? 'allowed' : 'denied'} by setting)`);

  const agentRunRoutesNow = () => new Date();
  const agentRunRouter = createAgentRunRoutes({
    cache: deps.cache,
    registry: agentRunRegistry,
    runStore,
    worktreeProvisioner,
    // provisioner が返す worktree パスは `git worktree list --porcelain` の realpath
    // なので、repoRoot から組み立てた期待値と揃えるにはガード側も realpath 正規化が要る
    // (/tmp と /private/tmp など)。infrastructure の実装をここで注入する。
    normalizePath: normalizePathForComparison,
    writeAccess: deps.writeAccess,
    isRemoteAgentRunAllowed: async () => remoteAgentRunsAllowed,
    // preflight (bdboard-pkr6.11) はハーネス表示と同じ組み立てを使う。
    // 「バッジは緑なのに run は 409」を避けるため、入力を 1 関数に寄せている。
    getHarnessStatus: (repoRootPath: string) =>
      readProjectHarnessStatus(
        {
          registry: deps.packRegistry,
          injector: deps.harnessInjector,
          contractReader: deps.harnessContractReader,
        },
        repoRootPath,
        agentRunRoutesNow(),
      ),
    now: agentRunRoutesNow,
    // run 開始時のチケット claim (bdboard-pkr6.26)。routes.ts のクイックアクション
    // claim と同じ issueWriter インスタンスを共有する。
    issueWriter: deps.issueWriter,
  });

  return { agentRunSettingsRouter, agentRunRouter, runStore };
}
