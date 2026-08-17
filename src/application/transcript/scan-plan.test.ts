import { describe, expect, it } from 'vitest';
import {
  INITIAL_TAIL_BYTES,
  TICK_BUDGET_BYTES,
  planScan,
  type ScanTarget,
} from './scan-plan.js';

function target(
  filePath: string,
  size: number,
  previousOffset: number | undefined,
  sessionId = filePath,
): ScanTarget {
  return { filePath, sessionId, size, previousOffset };
}

describe('planScan', () => {
  it('reads only the initial tail on first scan when size exceeds tail bytes', () => {
    const size = INITIAL_TAIL_BYTES + 500_000;
    const slices = planScan([target('/a/transcript.jsonl', size, undefined)]);

    expect(slices).toEqual([
      {
        filePath: '/a/transcript.jsonl',
        sessionId: '/a/transcript.jsonl',
        start: size - INITIAL_TAIL_BYTES,
        length: INITIAL_TAIL_BYTES,
        newOffset: size,
      },
    ]);
  });

  it('reads the full file on first scan when size is below initial tail bytes', () => {
    const size = INITIAL_TAIL_BYTES - 100;
    const slices = planScan([target('/a/transcript.jsonl', size, undefined)]);

    expect(slices).toEqual([
      {
        filePath: '/a/transcript.jsonl',
        sessionId: '/a/transcript.jsonl',
        start: 0,
        length: size,
        newOffset: size,
      },
    ]);
  });

  it('reads only appended bytes after previousOffset', () => {
    const previousOffset = 1_000;
    const size = 2_500;
    const slices = planScan([target('/a/transcript.jsonl', size, previousOffset)]);

    expect(slices).toEqual([
      {
        filePath: '/a/transcript.jsonl',
        sessionId: '/a/transcript.jsonl',
        start: previousOffset,
        length: size - previousOffset,
        newOffset: size,
      },
    ]);
  });

  it('re-reads from tail when file shrinks', () => {
    const size = 1_000_000;
    const slices = planScan([target('/a/transcript.jsonl', size, 5_000_000)]);

    expect(slices).toEqual([
      {
        filePath: '/a/transcript.jsonl',
        sessionId: '/a/transcript.jsonl',
        start: 0,
        length: size,
        newOffset: size,
      },
    ]);
  });

  it('creates no slice when previousOffset equals size', () => {
    const slices = planScan([target('/a/transcript.jsonl', 1_000, 1_000)]);
    expect(slices).toEqual([]);
  });

  it('stops when total length would exceed budgetBytes', () => {
    const budget = 1_000;
    const slices = planScan(
      [
        target('/a/transcript.jsonl', 600, undefined),
        target('/b/transcript.jsonl', 600, undefined),
      ],
      { budgetBytes: budget },
    );

    expect(slices).toHaveLength(2);
    expect(slices[0]?.length).toBe(600);
    expect(slices[1]?.length).toBe(400);
    expect(slices.reduce((sum, slice) => sum + slice.length, 0)).toBeLessThanOrEqual(budget);
  });

  it('truncates a single oversized target to the remaining budget', () => {
    const budget = 500;
    const size = 2_000;
    const slices = planScan([target('/a/transcript.jsonl', size, undefined)], {
      budgetBytes: budget,
      initialTailBytes: size,
    });

    expect(slices).toEqual([
      {
        filePath: '/a/transcript.jsonl',
        sessionId: '/a/transcript.jsonl',
        start: 0,
        length: budget,
        newOffset: budget,
      },
    ]);
  });

  it('prioritizes tracked targets before first-time targets', () => {
    const slices = planScan([
      target('/z/transcript.jsonl', 100, undefined),
      target('/a/transcript.jsonl', 200, 50),
    ]);

    expect(slices.map((slice) => slice.filePath)).toEqual([
      '/a/transcript.jsonl',
      '/z/transcript.jsonl',
    ]);
  });

  it('is deterministic regardless of input order', () => {
    const inputs: readonly ScanTarget[] = [
      target('/c/transcript.jsonl', 300, undefined),
      target('/a/transcript.jsonl', 200, 50),
      target('/b/transcript.jsonl', 400, 100),
      target('/d/transcript.jsonl', 500, undefined),
    ];
    const shuffled = [...inputs].reverse();

    expect(planScan(shuffled)).toEqual(planScan(inputs));
    expect(planScan(inputs).map((slice) => slice.filePath)).toEqual([
      '/a/transcript.jsonl',
      '/b/transcript.jsonl',
      '/c/transcript.jsonl',
      '/d/transcript.jsonl',
    ]);
  });

  it('uses default budget constant', () => {
    const slices = planScan([target('/a/transcript.jsonl', 100, undefined)]);
    expect(slices[0]?.length).toBe(100);
    expect(TICK_BUDGET_BYTES).toBe(8 * 1024 * 1024);
  });
});
