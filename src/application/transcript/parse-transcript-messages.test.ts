import { describe, expect, it } from 'vitest';
import {
  extractTranscriptIdentity,
  parseTranscriptTailMessages,
} from './parse-transcript-messages.js';

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

describe('parseTranscriptTailMessages', () => {
  it('extracts string content for user and assistant', () => {
    const jsonl = [
      line({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-06-20T11:03:56.949Z',
      }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: 'hi there' },
      }),
    ].join('\n');

    const messages = parseTranscriptTailMessages(jsonl, 50);

    expect(messages).toEqual([
      {
        role: 'user',
        text: 'hello',
        timestamp: '2026-06-20T11:03:56.949Z',
      },
      { role: 'assistant', text: 'hi there' },
    ]);
  });

  it('extracts only text blocks from array content', () => {
    const jsonl = line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'thinking', thinking: 'secret' },
          { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
          { type: 'text', text: 'part two' },
          { type: 'image', source: { type: 'base64' } },
        ],
      },
    });

    const messages = parseTranscriptTailMessages(jsonl, 50);

    expect(messages).toEqual([{ role: 'assistant', text: 'part one part two' }]);
  });

  it('excludes tool_use-only and tool_result-only messages', () => {
    const jsonl = [
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'file contents',
            },
          ],
        },
      }),
      line({
        type: 'user',
        message: { role: 'user', content: 'visible' },
      }),
    ].join('\n');

    const messages = parseTranscriptTailMessages(jsonl, 50);

    expect(messages).toEqual([{ role: 'user', text: 'visible' }]);
  });

  it('skips partial first line and parses subsequent complete lines', () => {
    const brokenPrefix = '{"type":"user","message":{"role":"user","content":"cut';
    const complete = line({
      type: 'assistant',
      message: { role: 'assistant', content: 'after partial' },
    });
    const jsonl = `${brokenPrefix}\n${complete}`;

    const messages = parseTranscriptTailMessages(jsonl, 50);

    expect(messages).toEqual([{ role: 'assistant', text: 'after partial' }]);
  });

  it('returns the latest messages up to limit in chronological order', () => {
    const jsonl = Array.from({ length: 5 }, (_, index) =>
      line({
        type: 'user',
        message: { role: 'user', content: `msg-${index}` },
      }),
    ).join('\n');

    const messages = parseTranscriptTailMessages(jsonl, 2);

    expect(messages).toEqual([
      { role: 'user', text: 'msg-3' },
      { role: 'user', text: 'msg-4' },
    ]);
  });

  it('truncates individual messages to 4000 characters', () => {
    const longText = 'a'.repeat(5000);
    const jsonl = line({
      type: 'user',
      message: { role: 'user', content: longText },
    });

    const messages = parseTranscriptTailMessages(jsonl, 50);

    expect(messages).toHaveLength(1);
    expect(messages[0].text).toHaveLength(4000);
    expect(messages[0].text).toBe('a'.repeat(4000));
  });

  it('drops oldest messages when total text exceeds 20000 characters', () => {
    const chunk = 'b'.repeat(4000);
    const jsonl = Array.from({ length: 6 }, () =>
      line({
        type: 'user',
        message: { role: 'user', content: chunk },
      }),
    ).join('\n');

    const messages = parseTranscriptTailMessages(jsonl, 50);

    expect(messages).toHaveLength(5);
    expect(messages.map((message) => message.text)).toEqual(
      Array.from({ length: 5 }, () => chunk),
    );
  });

  it('ignores non user/assistant lines and invalid JSON', () => {
    const jsonl = [
      'not json',
      line({ type: 'system', message: { role: 'system', content: 'sys' } }),
      line({ type: 'summary', content: 'summary text' }),
      line({
        type: 'user',
        message: { role: 'user', content: 'ok' },
        isMeta: true,
      }),
      line({
        type: 'user',
        message: { role: 'user', content: 'kept' },
      }),
    ].join('\n');

    const messages = parseTranscriptTailMessages(jsonl, 50);

    expect(messages).toEqual([{ role: 'user', text: 'kept' }]);
  });
});

describe('extractTranscriptIdentity', () => {
  it('returns the cwd and sessionId from the first qualifying user/assistant line', () => {
    const jsonl = [
      line({ type: 'queue-operation', operation: 'enqueue' }),
      line({
        type: 'user',
        message: { role: 'user', content: 'hi' },
        cwd: '/Users/example/project',
        sessionId: 'real-session-id',
      }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: 'reply' },
        cwd: '/should/not/be/used',
        sessionId: 'should-not-be-used',
      }),
    ].join('\n');

    expect(extractTranscriptIdentity(jsonl)).toEqual({
      cwd: '/Users/example/project',
      sessionId: 'real-session-id',
    });
  });

  it('skips lines without both cwd and sessionId, and lines that are not valid JSON', () => {
    const jsonl = [
      'not json {',
      line({ type: 'user', message: { role: 'user', content: 'no cwd' } }),
      line({
        type: 'user',
        message: { role: 'user', content: 'has both' },
        cwd: '/work/app',
        sessionId: 'sess-1',
      }),
    ].join('\n');

    expect(extractTranscriptIdentity(jsonl)).toEqual({
      cwd: '/work/app',
      sessionId: 'sess-1',
    });
  });

  it('returns undefined when no line has both fields (e.g. a truncated head chunk)', () => {
    const jsonl = [
      line({ type: 'system', message: { role: 'system', content: 'sys' } }),
      '{"type":"user","message":{"content":"cut off mid',
    ].join('\n');

    expect(extractTranscriptIdentity(jsonl)).toBeUndefined();
  });
});
