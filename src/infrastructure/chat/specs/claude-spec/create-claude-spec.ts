import type { CliChatAgentSpec, CliTurnPlan } from '../../cli-chat-agent.js';
import { buildClaudeArgs, buildStreamingClaudeArgs } from './args.js';
import { classifyClaudeFailure, interpretClaudeAuthProbe } from './auth-and-failure.js';
import { CLAUDE_ENV_ALLOWLIST } from './env.js';
import {
  buildClaudeChatModels,
  normalizeModelList,
  resolveClaudeModelIds,
  resolveClaudeModelWeights,
  type ClaudeModelWeights,
} from './models.js';
import { parseClaudeStreamChunk, parseClaudeStreamResult, parseClaudeTurn } from './output-parsing.js';

export interface ClaudeSpecOptions {
  readonly claudePath: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly modelWeights?: ClaudeModelWeights;
  readonly models?: readonly string[];
}

export function createClaudeSpec(options: ClaudeSpecOptions): CliChatAgentSpec {
  const resolvedWeights = resolveClaudeModelWeights(options.modelWeights ?? {});
  const models = normalizeModelList(
    options.model,
    buildClaudeChatModels(resolveClaudeModelIds(options.models), resolvedWeights),
    resolvedWeights,
  );

  const descriptor: CliChatAgentSpec['descriptor'] = {
    id: 'claude',
    label: 'Claude Code',
    model: options.model,
    models,
    experimental: false,
    capability: 'bd-only',
    supportsStreaming: true,
  };

  return {
    descriptor,
    binaryPath: options.claudePath,
    envAllowlist: CLAUDE_ENV_ALLOWLIST,
    versionArgs: ['--version'],
    // 認証まで見る(bdboard-15v)。`auth status --json` はモデルを呼ばないので課金は発生しない。
    // 認証済み: exit 0 + {"loggedIn":true,...} / 未認証: exit 1 + {"loggedIn":false,...}
    authProbe: {
      args: ['auth', 'status', '--json'],
      interpret: interpretClaudeAuthProbe,
    },
    timeoutMs: options.timeoutMs,
    classifyFailure: classifyClaudeFailure,
    buildTurn(request, ctx): CliTurnPlan {
      return {
        args: buildClaudeArgs(request, ctx, request.model ?? options.model),
        stdin: request.message,
      };
    },
    buildStreamingTurn(request, ctx): CliTurnPlan {
      return {
        args: buildStreamingClaudeArgs(request, ctx, request.model ?? options.model),
        stdin: request.message,
      };
    },
    supportsStreaming: true,
    parseStreamChunk: parseClaudeStreamChunk,
    parseStreamResult: parseClaudeStreamResult,
    parseTurn: parseClaudeTurn,
  };
}
