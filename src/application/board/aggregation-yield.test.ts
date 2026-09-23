import { describe, expect, it } from 'vitest';
import { AGGREGATION_YIELD_CHUNK_SIZE, createYieldGate, forEachChunked, yieldToEventLoop } from './aggregation-yield.js';

// These tests assert relative ordering against a competing setImmediate
// task instead of counting global setImmediate calls: Node/Vitest may
// schedule their own unrelated setImmediate callbacks in the background,
// which makes exact call-count assertions on a spied global.setImmediate
// flaky. Ordering against a task we control is deterministic: Node fully
// drains the microtask queue between any two macrotasks (setImmediate
// callbacks), so "did a competing macrotask run in between" reliably
// distinguishes "yielded at least once" from "ran fully synchronously".
async function raceAgainstOneMacrotask(work: () => Promise<void>): Promise<string[]> {
  const events: string[] = [];
  const competingTask = new Promise<void>((resolve) => {
    setImmediate(() => {
      events.push('competing-task');
      resolve();
    });
  });
  const workDone = work().then(() => {
    events.push('work-done');
  });
  await Promise.all([competingTask, workDone]);
  return events;
}

describe('yieldToEventLoop', () => {
  it('resolves via setImmediate (a macrotask), not merely a microtask', async () => {
    const order: string[] = [];
    const pending = yieldToEventLoop().then(() => {
      order.push('yielded');
    });
    // A microtask queued before the setImmediate-based yield must run
    // first, since Node drains the microtask queue before any macrotask.
    await Promise.resolve().then(() => {
      order.push('microtask');
    });
    await pending;
    expect(order).toEqual(['microtask', 'yielded']);
  });

  // The test above alone would still pass if yieldToEventLoop degraded to
  // `await Promise.resolve()` (a microtask-only "yield" that never actually
  // frees the event loop for other pending requests), because it only
  // checks ordering against a microtask queued *before* it, not against a
  // competing macrotask. This test catches exactly that regression: a
  // competing setImmediate task must be able to run in between.
  it('lets a competing macrotask run in between (regression guard for a microtask-only implementation)', async () => {
    const events = await raceAgainstOneMacrotask(() => yieldToEventLoop());
    expect(events).toEqual(['competing-task', 'work-done']);
  });
});

describe('forEachChunked', () => {
  it('visits every item exactly once, in order', async () => {
    const items = Array.from({ length: 1234 }, (_, index) => index);
    const visited: number[] = [];

    await forEachChunked(items, (item) => {
      visited.push(item);
    });

    expect(visited).toEqual(items);
  });

  it('does not yield for an array smaller than the chunk size (finishes before the next macrotask)', async () => {
    const items = Array.from({ length: AGGREGATION_YIELD_CHUNK_SIZE - 1 }, (_, i) => i);

    const events = await raceAgainstOneMacrotask(() => forEachChunked(items, () => {}));

    expect(events).toEqual(['work-done', 'competing-task']);
  });

  it('handles an empty array without yielding (finishes before the next macrotask)', async () => {
    const events = await raceAgainstOneMacrotask(() =>
      forEachChunked([], () => {
        throw new Error('should not be called');
      }),
    );

    expect(events).toEqual(['work-done', 'competing-task']);
  });

  it('yields at least once for an array spanning multiple chunks (a competing macrotask interleaves)', async () => {
    const items = Array.from({ length: AGGREGATION_YIELD_CHUNK_SIZE * 3 }, (_, i) => i);

    const events = await raceAgainstOneMacrotask(() => forEachChunked(items, () => {}));

    expect(events).toEqual(['competing-task', 'work-done']);
  });
});

describe('createYieldGate', () => {
  it('shares one running counter across multiple arrays/loops instead of resetting per call', async () => {
    // Two arrays that are each individually below the chunk size, but
    // whose combined total crosses it, must still yield when processed
    // through the same shared gate (bdboard-ve1y: getThroughputStats
    // shares one gate across all projects for exactly this reason).
    const gate = createYieldGate(10);
    const first = Array.from({ length: 6 }, (_, i) => i);
    const second = Array.from({ length: 6 }, (_, i) => i);

    const events = await raceAgainstOneMacrotask(async () => {
      await forEachChunked(first, () => {}, gate);
      await forEachChunked(second, () => {}, gate);
    });

    expect(events).toEqual(['competing-task', 'work-done']);
  });

  it('does not yield when two arrays share a gate but their combined total stays under the chunk size', async () => {
    const gate = createYieldGate(100);
    const first = Array.from({ length: 6 }, (_, i) => i);
    const second = Array.from({ length: 6 }, (_, i) => i);

    const events = await raceAgainstOneMacrotask(async () => {
      await forEachChunked(first, () => {}, gate);
      await forEachChunked(second, () => {}, gate);
    });

    expect(events).toEqual(['work-done', 'competing-task']);
  });
});
