import { compareStrings } from '../../domain/compare.js';

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface ModelUsageTotals extends UsageTotals {
  readonly model: string;
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const UNKNOWN_MODEL = 'unknown';

function readNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function extractUsageFromMessage(message: Record<string, unknown>): UsageTotals {
  const usage = message.usage;
  if (typeof usage !== 'object' || usage === null) {
    return EMPTY_USAGE;
  }

  const usageRecord = usage as Record<string, unknown>;
  return {
    inputTokens: readNonNegativeInt(usageRecord.input_tokens),
    outputTokens: readNonNegativeInt(usageRecord.output_tokens),
    cacheCreationInputTokens: readNonNegativeInt(
      usageRecord.cache_creation_input_tokens,
    ),
    cacheReadInputTokens: readNonNegativeInt(usageRecord.cache_read_input_tokens),
  };
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationInputTokens:
      left.cacheCreationInputTokens + right.cacheCreationInputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
  };
}

function parseAssistantUsageLine(line: string): ModelUsageTotals | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  if (record.isMeta === true) {
    return undefined;
  }

  if (record.type !== 'assistant') {
    return undefined;
  }

  const message = record.message;
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }

  const messageRecord = message as Record<string, unknown>;
  const model =
    typeof messageRecord.model === 'string' && messageRecord.model.length > 0
      ? messageRecord.model
      : UNKNOWN_MODEL;
  const usage = extractUsageFromMessage(messageRecord);

  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheCreationInputTokens === 0 &&
    usage.cacheReadInputTokens === 0
  ) {
    return undefined;
  }

  return {
    model,
    ...usage,
  };
}

export function extractUsageTotals(text: string): readonly ModelUsageTotals[] {
  if (text.length === 0) {
    return [];
  }

  const byModel = new Map<string, UsageTotals>();

  for (const line of text.split('\n')) {
    const usage = parseAssistantUsageLine(line);
    if (usage === undefined) {
      continue;
    }

    const existing = byModel.get(usage.model) ?? EMPTY_USAGE;
    byModel.set(usage.model, addUsage(existing, usage));
  }

  return [...byModel.entries()]
    .map(([model, totals]) => ({ model, ...totals }))
    .sort((left, right) => compareStrings(left.model, right.model));
}
