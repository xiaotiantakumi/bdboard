import { z } from 'zod';
import { ChatAgentError, type ChatTurnResult } from '../../../../application/ports/chat-agent.js';
import type { CommandResult } from '../../../../application/ports/command-runner.js';

type ModelUsageEntry = {
  costUSD?: number;
  canonicalModel?: string;
};

type ModelUsageMap = Record<string, ModelUsageEntry>;

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

export function parseClaudeStreamChunk(line: string): { readonly delta?: string } | undefined {
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
}

export function parseClaudeStreamResult(
  fullStdout: string,
  _readLastMessageFile: () => string | undefined,
): Omit<ChatTurnResult, 'agentId'> {
  const lastLine = fullStdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (lastLine === undefined) {
    throw new ChatAgentError('agent-bad-output');
  }
  return parseClaudeResultLine(lastLine);
}

export function parseClaudeTurn(
  result: CommandResult,
  _readLastMessageFile: () => string | undefined,
): Omit<ChatTurnResult, 'agentId'> {
  return parseClaudeResultLine(result.stdout);
}
