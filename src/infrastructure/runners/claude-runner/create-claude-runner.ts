// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// createClaudeRunner() 本体。dispatch() の結果分岐 (streamingRunner.run() の戻り値を
// RunOutcome へ変換する部分) は buildDispatchResultOutcome() (./dispatch-result.js) へ
// 切り出し済みで、ここでは呼び出すだけにしている。
import type {
  AgentRunner,
  RunOutcome,
  RunOutputSink,
  RunRequest,
} from '../../../application/ports/agent-runner.js';
import { buildClaudeCommand } from '../../../application/runner/build-claude-args.js';
import type { RunMode } from '../../../domain/run.js';
import { buildDispatchResultOutcome } from './dispatch-result.js';
import type { ClaudeRunnerOptions } from './options.js';
import {
  DEFAULT_SETTING_SOURCES,
  DENIED_TOOLS,
  resolveAllowedTools,
  resolvePermissionMode,
} from './permission-policy.js';
import { buildOutcome, resolveTimeoutMs } from './run-outcome.js';
import { buildRunnerEnv } from './runner-env.js';
import { resolveClaudeVersionCheck } from './version-probe.js';
import { clearWorktreeLocalClaudeSettings } from './worktree-settings-cleanup.js';
import {
  buildWorktreeScopedDenials,
  buildWorktreeScopedTools,
} from './worktree-scoped-permissions.js';

/**
 * Shared factory for the official `claude` runners. `spawn` and `resume` differ
 * only in which mode they accept and in their id; keeping one implementation
 * prevents the two from drifting apart when dispatch is eventually implemented.
 */
export function createClaudeRunner(
  id: string,
  mode: RunMode,
  options?: ClaudeRunnerOptions,
): AgentRunner {
  const claudePath = options?.claudePath ?? process.env.BDBOARD_CLAUDE_PATH ?? 'claude';
  const streamingRunner = options?.streamingRunner;
  const permissionMode = resolvePermissionMode(options);
  const allowedTools = resolveAllowedTools(options);
  const timeoutMs = resolveTimeoutMs(options);

  return {
    id,
    experimental: false,
    supports: (request: RunRequest) => request.mode === mode,
    async dispatch(
      request: RunRequest,
      sink?: RunOutputSink,
    ): Promise<RunOutcome> {
      const startedAt = new Date();

      let command: string;
      let args: readonly string[];
      try {
        const effectiveAllowedTools =
          allowedTools === undefined
            ? undefined
            : [
                ...allowedTools,
                ...buildWorktreeScopedTools(request.cwd),
              ];
        // deny 側は allowedTools の有無に関わらず必ず付ける。
        // BDBOARD_RUN_ALLOWED_TOOLS='' で allowlist を降ろした運用では
        // `.claude/**` を覆う allow すら無い代わりに天井そのものが緩むので、
        // 自己昇格の経路を塞ぐ必要はむしろ強くなる。
        ({ command, args } = buildClaudeCommand(request, {
          claudePath,
          permissionMode,
          settingSources: DEFAULT_SETTING_SOURCES,
          allowedTools: effectiveAllowedTools,
          disallowedTools: [
            ...DENIED_TOOLS,
            ...buildWorktreeScopedDenials(request.cwd),
          ],
        }));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return buildOutcome(id, request, startedAt, 'invalid-request', detail);
      }

      if (streamingRunner === undefined) {
        return buildOutcome(
          id,
          request,
          startedAt,
          'dispatch-disabled',
          `dispatch disabled (no streaming runner wired): would run: ${command} ${args.join(' ')}`,
        );
      }

      // dispatch-disabled の既存挙動を変えないため、streamingRunner 有無の判定の後に置く。
      // too-old で弾く run では worktree の settings.local.json を消さないため、
      // clearWorktreeLocalClaudeSettings() より前に置く。
      const versionCheck = await resolveClaudeVersionCheck(
        streamingRunner,
        claudePath,
      );
      if (versionCheck.status === 'too-old') {
        return buildOutcome(
          id,
          request,
          startedAt,
          'runner-unavailable',
          versionCheck.message,
        );
      }
      if (versionCheck.status === 'unknown') {
        console.warn(versionCheck.message);
      }

      // cwd の形が buildWorktreeScopedTools を通過し、実際に起動する直前まで来てから
      // 消す。ここより前だと (a) 壊れた cwd でも削除が走り、(b) dispatch-disabled で
      // 起動しないのにファイルだけ消える。
      clearWorktreeLocalClaudeSettings(request.cwd);

      const onChunk = sink?.onChunk ?? (() => {});

      const result = await streamingRunner.run(command, args, {
        cwd: request.cwd,
        env: buildRunnerEnv(),
        timeoutMs,
        onChunk,
        signal: sink?.signal,
      });

      return buildDispatchResultOutcome(id, request, startedAt, result);
    },
  };
}
