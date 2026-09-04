// bdboard-njaf: bd-prime-guard.mjs のテスト。
import { describe, expect, it } from 'vitest';

import {
  annotateMissingMemories,
  classifyPrimeOutput,
  MEMORIES_MARKER,
  MISSING_MEMORIES_WARNING,
  resolvePrimeOutput,
} from './bd-prime-guard.mjs';

function payload(context) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  });
}

const WITH_MEMORIES = payload(`# Beads Workflow Context\n\n${MEMORIES_MARKER} (21)\n\n### some-key\nvalue`);
// 実測された欠落時の形。見出しごと無く、件数 (0) すら出ない点がこの不具合の肝。
const WITHOUT_MEMORIES = payload('# Beads Workflow Context\n\n## Core Rules\n- Use beads');

describe('classifyPrimeOutput', () => {
  it('accepts output that carries the memories block', () => {
    expect(classifyPrimeOutput(WITH_MEMORIES).status).toBe('ok');
  });

  it('flags output whose memories block is absent entirely', () => {
    expect(classifyPrimeOutput(WITHOUT_MEMORIES).status).toBe('missing-memories');
  });

  it('treats an empty or non-JSON stdout as unparsable rather than as missing memories', () => {
    // bd 自体が失敗したケースを missing-memories と取り違えると、再実行と警告差し込みで
    // 状況を悪化させる。素通しに倒すことを固定する。
    expect(classifyPrimeOutput('').status).toBe('unparsable');
    expect(classifyPrimeOutput('   ').status).toBe('unparsable');
    expect(classifyPrimeOutput('not json at all').status).toBe('unparsable');
    expect(classifyPrimeOutput(undefined).status).toBe('unparsable');
  });

  it('treats a JSON payload without additionalContext as unparsable', () => {
    expect(classifyPrimeOutput(JSON.stringify({ hookSpecificOutput: {} })).status).toBe(
      'unparsable',
    );
  });
});

describe('annotateMissingMemories', () => {
  it('prepends the warning and keeps the original context', () => {
    const annotated = annotateMissingMemories(JSON.parse(WITHOUT_MEMORIES));
    const context = annotated.hookSpecificOutput.additionalContext;
    expect(context.startsWith(MISSING_MEMORIES_WARNING)).toBe(true);
    expect(context).toContain('## Core Rules');
    expect(annotated.hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
});

describe('resolvePrimeOutput', () => {
  it('does not retry when the first attempt already has memories', () => {
    let calls = 0;
    const result = resolvePrimeOutput(() => {
      calls += 1;
      return WITH_MEMORIES;
    });
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.status).toBe('ok');
    expect(result.output).toBe(WITH_MEMORIES);
  });

  it('retries once and uses the recovered output', () => {
    const outputs = [WITHOUT_MEMORIES, WITH_MEMORIES];
    let calls = 0;
    const result = resolvePrimeOutput(() => outputs[calls++]);
    expect(calls).toBe(2);
    expect(result.status).toBe('recovered');
    expect(result.output).toBe(WITH_MEMORIES);
    // 復旧した以上、警告は出さない。出すと本当の欠落と区別がつかなくなる。
    expect(result.output).not.toContain(MISSING_MEMORIES_WARNING);
  });

  it('annotates instead of swallowing when both attempts drop memories', () => {
    let calls = 0;
    const result = resolvePrimeOutput(() => {
      calls += 1;
      return WITHOUT_MEMORIES;
    });
    expect(calls).toBe(2);
    expect(result.status).toBe('missing-memories');
    const parsed = JSON.parse(result.output);
    expect(parsed.hookSpecificOutput.additionalContext).toContain(MISSING_MEMORIES_WARNING);
    // 元の内容を捨てないこと。警告だけ出して prime 本体を失うほうが害が大きい。
    expect(parsed.hookSpecificOutput.additionalContext).toContain('## Core Rules');
  });

  it('passes an unparsable first attempt through untouched without retrying', () => {
    let calls = 0;
    const result = resolvePrimeOutput(() => {
      calls += 1;
      return 'bd: command not found';
    });
    expect(calls).toBe(1);
    expect(result.status).toBe('unparsable');
    expect(result.output).toBe('bd: command not found');
  });

  it('falls back to annotating the first attempt when the retry is unparsable', () => {
    const outputs = [WITHOUT_MEMORIES, ''];
    let calls = 0;
    const result = resolvePrimeOutput(() => outputs[calls++]);
    expect(result.status).toBe('missing-memories');
    // 読めた1回目 + 警告のほうが、壊れた2回目より情報量が多い。
    expect(JSON.parse(result.output).hookSpecificOutput.additionalContext).toContain('## Core Rules');
  });
});
