import { z } from 'zod';
import {
  ChatAgentError,
  type ChatAgentAvailability,
  type ChatModelOption,
  type ChatTurnRequest,
  type ChatTurnResult,
} from '../../../application/ports/chat-agent.js';
import type { CommandResult } from '../../../application/ports/command-runner.js';
import type {
  CliChatAgentSpec,
  CliMcpServerSpec,
  CliTurnContext,
  CliTurnPlan,
} from '../cli-chat-agent.js';

type ModelUsageEntry = {
  costUSD?: number;
  canonicalModel?: string;
};

type ModelUsageMap = Record<string, ModelUsageEntry>;

export const CLAUDE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  'CLAUDE_CONFIG_DIR',
] as const;

const claudeOutputSchema = z.object({
  result: z.string(),
  session_id: z.string(),
  is_error: z.boolean().optional(),
  permission_denials: z
    .array(
      z.object({
        tool_name: z.string(),
      }),
    )
    .optional(),
  // 非公式・未文書化のフィールド。取得できなくても reply は返す必要があるので、
  // 形が変わったら黙って undefined に落とす (turn 全体を落とさない)。
  modelUsage: z
    .record(
      z.string(),
      z.object({
        costUSD: z.number().optional(),
        canonicalModel: z.string().optional(),
      }).passthrough(),
    )
    .optional()
    .catch(undefined),
});

/**
 * `modelUsage` の `costUSD` 最大エントリを実際に使われたモデルとして推定する。
 * これは claude CLI 2.1.233 での経験的な観測に基づく非公式・未文書化の仕様であり、
 * CLI のバージョンアップでフィールドの形や意味が変わる可能性がある。
 * 毎ターン別プロセスの `-p --resume` を前提にしている。`--input-format stream-json`
 * (streaming-input) に移行すると modelUsage はターンをまたいで累積し、ターン単位の実測でなくなる。
 * 同額 (crash/startup-error 時の zeroed usage 等) では、どのモデルが実際に使われたターンなのか
 * 区別がつかない。誤った実測値を返すくらいなら欠測にしてエコー (呼び出し元の request.model /
 * descriptor.model へのフォールバック) に倒す。
 */
function pickActualModel(modelUsage: ModelUsageMap | undefined): string | undefined {
  if (modelUsage === undefined) {
    return undefined;
  }

  const entries = Object.entries(modelUsage);
  if (entries.length === 0) {
    return undefined;
  }
  if (entries.length === 1) {
    const [key, entry] = entries[0];
    return entry.canonicalModel ?? key;
  }

  const maxCost = Math.max(...entries.map(([, entry]) => entry.costUSD ?? 0));
  const maxEntries = entries.filter(([, entry]) => (entry.costUSD ?? 0) === maxCost);
  if (maxEntries.length !== 1) {
    return undefined;
  }

  const [key, entry] = maxEntries[0];
  return entry.canonicalModel ?? key;
}

/** `claude auth status --json` の出力。使うのは loggedIn だけなので passthrough でよい。 */
const claudeAuthStatusSchema = z.object({
  loggedIn: z.boolean(),
});

/**
 * 並び順は「安い方を先頭」にしてある。descriptor.model を設定せず models だけを持つ
 * spec が将来現れると UI の既定は models[0] に落ちるので、先頭が Opus だと黙って
 * 最も高価なモデルが全員の既定になる。先頭は Sonnet で固定しておく。
 */
export interface ClaudeModelWeights {
  readonly sonnet?: number;
  readonly opus?: number;
  readonly haiku?: number;
}

// 相対コストの目安は Opus : Sonnet : Haiku ≈ 5 : 1 : 1。1 未満にしないのは、perMinute/perDay が
// 課金上限であると同時に、公開トンネル経由の CLI 子プロセス起動レートの上限でもあるため
// (chat-routes.ts の agents 非免除コメント参照)。安いモデルの重みを 0.25 にすると、既存の
// 起動レート上限が黙って 4 倍に緩んでしまう。緩めたい運用者は BDBOARD_CHAT_RATE_WEIGHT_HAIKU
// で明示的にオプトインできる。
// (このコメントは元々 chat-rate-limit.ts の DEFAULT_CHAT_RATE_LIMIT_WEIGHTS に付いていたものを、
// 重みの宣言元がここに一元化されたことに合わせて移設した — bdboard-3tw.104.11)
export const DEFAULT_CLAUDE_MODEL_WEIGHTS: Required<ClaudeModelWeights> = {
  sonnet: 1,
  opus: 5,
  haiku: 1,
};

/**
 * `options.modelWeights` の未指定フィールドを DEFAULT_CLAUDE_MODEL_WEIGHTS で埋めた完全形にする。
 * 重みの既定値適用はこの spec に一元化されている(bdboard-3tw.104.11 Opus レビュー N2)ので、
 * 呼び出し元(chat-agent-registry-builder.ts)は env が未設定/不正なら `undefined` のまま渡してよい
 * — デフォルト値の重複宣言を避けるため、`??` によるフォールバックは必ずここに一本化すること。
 */
function resolveClaudeModelWeights(weights: ClaudeModelWeights): Required<ClaudeModelWeights> {
  return {
    sonnet: weights.sonnet ?? DEFAULT_CLAUDE_MODEL_WEIGHTS.sonnet,
    opus: weights.opus ?? DEFAULT_CLAUDE_MODEL_WEIGHTS.opus,
    haiku: weights.haiku ?? DEFAULT_CLAUDE_MODEL_WEIGHTS.haiku,
  };
}

function buildClaudeChatModels(weights: Required<ClaudeModelWeights>): readonly ChatModelOption[] {
  return [
    { id: 'sonnet', label: 'Sonnet', weight: weights.sonnet },
    { id: 'opus', label: 'Opus', weight: weights.opus },
    { id: 'haiku', label: 'Haiku', weight: weights.haiku },
  ];
}

/**
 * 既定重みのスナップショット(env による上書き前の参照値)。実行時に実際に使われる重みは
 * `createClaudeSpec(...).descriptor.models` を見ること — `BDBOARD_CHAT_RATE_WEIGHT_*` で
 * 上書きされていればこの定数とは値がずれる(bdboard-3tw.104.11 Opus レビュー N1)。
 * 並び順は既存どおり「安い方を先頭」(Sonnet 先頭)を維持すること。
 */
export const CLAUDE_CHAT_MODELS: readonly ChatModelOption[] = buildClaudeChatModels(DEFAULT_CLAUDE_MODEL_WEIGHTS);

export interface ClaudeSpecOptions {
  readonly claudePath: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly modelWeights?: ClaudeModelWeights;
}

/**
 * `options.model`(例: BDBOARD_CHAT_MODEL で運用者が指定したカスタムモデル ID)が
 * CLAUDE_CHAT_MODELS の一覧に無い場合の重み推定(bdboard-3tw.104.11 Opus レビュー MF1)。
 *
 * 修正前は normalizeModelList が prepend するエントリに weight を付けておらず、一覧外の
 * 独自 opus 系 ID を既定モデルにしている運用者のリクエストが、宣言なし → chat-routes.ts の
 * default フォールバックに落ちて 5 のはずが 1 で数えられる回帰になっていた(実測確認済み)。
 *
 * ここでの opus/haiku/sonnet 文字列判定は claude 固有の命名規則に基づくもので、この spec の
 * 内側に閉じている。本チケットの趣旨は「重み知識が interface 層と infrastructure 層の 2 箇所に
 * 複製されること」の解消であって、「claude-spec が Claude 自身の命名知識を持つこと」自体は
 * 正当な自己完結性なので許容する。
 */
function weightForUnlistedClaudeModel(id: string, weights: Required<ClaudeModelWeights>): number {
  const normalized = id.toLowerCase();
  if (normalized.includes('opus')) {
    return weights.opus;
  }
  if (normalized.includes('haiku')) {
    return weights.haiku;
  }
  return weights.sonnet;
}

function normalizeModelList(
  defaultModel: string,
  models: readonly ChatModelOption[],
  weights: Required<ClaudeModelWeights>,
): readonly ChatModelOption[] {
  if (models.some((entry) => entry.id === defaultModel)) {
    return models;
  }
  return [
    { id: defaultModel, label: defaultModel, weight: weightForUnlistedClaudeModel(defaultModel, weights) },
    ...models,
  ];
}

function buildAllowedToolsValue(toolNames: readonly string[]): string {
  return toolNames.map((name) => `mcp__bd__${name}`).join(',');
}

function buildMcpConfigJson(mcpServers: readonly CliMcpServerSpec[]): string {
  const servers: Record<string, { command: string; args: string[] }> = {};
  for (const server of mcpServers) {
    servers[server.name] = {
      command: server.command,
      args: [...server.args],
    };
  }

  return JSON.stringify({ mcpServers: servers });
}

function buildClaudeArgs(
  request: ChatTurnRequest,
  ctx: CliTurnContext,
  model: string,
): string[] {
  const mcpConfig = buildMcpConfigJson(ctx.mcpServers);

  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--system-prompt',
    ctx.systemPrompt,
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--allowedTools',
    buildAllowedToolsValue(ctx.toolNames),
    '--setting-sources',
    '',
  ];

  if (request.resumeSessionId !== undefined) {
    args.push('--resume', request.resumeSessionId);
  }

  return args;
}

function buildStreamingClaudeArgs(
  request: ChatTurnRequest,
  ctx: CliTurnContext,
  model: string,
): string[] {
  const args = buildClaudeArgs(request, ctx, model);
  // bdboard-l1t.9 Opus レビュー N1: args.indexOf('json') は値の中身で検索していて、
  // 将来 'json' という文字列を持つ別の引数(モデル名やメッセージ本文由来)が
  // 紛れ込むと誤検出しうる脆い実装だった。--output-format フラグの「次の要素」を
  // 位置で特定する方が堅い。
  const outputFormatFlagIndex = args.indexOf('--output-format');
  if (outputFormatFlagIndex === -1 || outputFormatFlagIndex + 1 >= args.length) {
    throw new Error('buildClaudeArgs did not include --output-format');
  }
  args.splice(outputFormatFlagIndex + 1, 1, 'stream-json', '--include-partial-messages', '--verbose');
  return args;
}

function parseClaudeResultLine(line: string): Omit<ChatTurnResult, 'agentId'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ChatAgentError('agent-bad-output');
  }

  const validated = claudeOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ChatAgentError('agent-unexpected-output');
  }

  const failedTools = (validated.data.permission_denials ?? []).map(
    (denial) => denial.tool_name,
  );
  const actualModel = pickActualModel(validated.data.modelUsage);
  return {
    reply: validated.data.result,
    sessionId: validated.data.session_id,
    failedTools,
    ...(actualModel !== undefined ? { model: actualModel } : {}),
  };
}

export function createClaudeSpec(options: ClaudeSpecOptions): CliChatAgentSpec {
  const resolvedWeights = resolveClaudeModelWeights(options.modelWeights ?? {});
  const models = normalizeModelList(options.model, buildClaudeChatModels(resolvedWeights), resolvedWeights);

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
      interpret(result: CommandResult): ChatAgentAvailability {
        if (result.failureKind === 'timeout') {
          return 'unknown';
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          // `auth status` を持たない古い CLI などはここに来る。
          // 判断がつかないので 'unavailable' とも 'available' とも言わない。
          return 'unknown';
        }

        const validated = claudeAuthStatusSchema.safeParse(parsed);
        if (!validated.success) {
          return 'unknown';
        }

        return validated.data.loggedIn ? 'available' : 'unavailable';
      },
    },
    timeoutMs: options.timeoutMs,
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
    parseStreamChunk(line: string): { readonly delta?: string } | undefined {
      try {
        const parsed = JSON.parse(line) as {
          type?: unknown;
          event?: {
            type?: unknown;
            delta?: { type?: unknown; text?: unknown };
          };
        };
        if (
          parsed.type === 'stream_event' &&
          parsed.event?.type === 'content_block_delta' &&
          parsed.event.delta?.type === 'text_delta' &&
          typeof parsed.event.delta.text === 'string'
        ) {
          return { delta: parsed.event.delta.text };
        }
      } catch {
        // Individual JSONL diagnostics must not fail the whole turn.
      }
      return undefined;
    },
    parseStreamResult(fullStdout, _readLastMessageFile): Omit<ChatTurnResult, 'agentId'> {
      const lastLine = fullStdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1);
      if (lastLine === undefined) {
        throw new ChatAgentError('agent-bad-output');
      }
      return parseClaudeResultLine(lastLine);
    },
    parseTurn(result: CommandResult, _readLastMessageFile: () => string | undefined): Omit<ChatTurnResult, 'agentId'> {
      return parseClaudeResultLine(result.stdout);
    },
  };
}
