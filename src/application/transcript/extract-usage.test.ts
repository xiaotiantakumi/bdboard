import { describe, expect, it } from 'vitest';
import { extractUsageTotals } from './extract-usage.js';

function assistantLine(
  model: string,
  usage: Record<string, number>,
  options?: { isMeta?: boolean },
): string {
  return JSON.stringify({
    type: 'assistant',
    ...(options?.isMeta === true ? { isMeta: true } : {}),
    message: {
      model,
      content: [{ type: 'text', text: 'hello' }],
      usage,
    },
  });
}

describe('extractUsageTotals', () => {
  it('aggregates assistant usage by model', () => {
    const text = [
      assistantLine('claude-opus-5', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 50,
      }),
      assistantLine('claude-opus-5', {
        input_tokens: 2,
        output_tokens: 3,
      }),
      assistantLine('claude-sonnet-5', {
        input_tokens: 7,
        output_tokens: 1,
      }),
    ].join('\n');

    expect(extractUsageTotals(text)).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 12,
        outputTokens: 8,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
      },
      {
        model: 'claude-sonnet-5',
        inputTokens: 7,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    ]);
  });

  it('ignores user lines, meta assistant lines, and invalid json', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistantLine('claude-opus-5', { input_tokens: 1, output_tokens: 2 }, { isMeta: true }),
      '{not json',
      assistantLine('claude-opus-5', { input_tokens: 3, output_tokens: 4 }),
    ].join('\n');

    expect(extractUsageTotals(text)).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 3,
        outputTokens: 4,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    ]);
  });

  it('treats missing usage fields as zero', () => {
    const text = assistantLine('claude-opus-5', { input_tokens: 9 });

    expect(extractUsageTotals(text)).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 9,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    ]);
  });

  it('groups missing model under unknown', () => {
    const text = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 4, output_tokens: 1 },
      },
    });

    expect(extractUsageTotals(text)).toEqual([
      {
        model: 'unknown',
        inputTokens: 4,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    ]);
  });

  it('returns empty array for empty text', () => {
    expect(extractUsageTotals('')).toEqual([]);
  });
});
