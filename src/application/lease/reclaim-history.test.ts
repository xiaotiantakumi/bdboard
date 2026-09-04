import { describe, expect, it } from 'vitest';
import type { ReclaimRunRecord } from '../../domain/harness-kpi.js';
import { parseReclaimStdout } from './parse-reclaim-output.js';
import { createReclaimHistory, DEFAULT_RECLAIM_HISTORY_LIMIT } from './reclaim-history.js';

/** bd 1.2.1 の実出力 (空振り) */
const IDLE_STDOUT = '✓ No stale leases to reclaim';

function run(overrides: Partial<ReclaimRunRecord> = {}): ReclaimRunRecord {
  return {
    projectId: 'proj-a',
    at: new Date('2026-08-10T00:00:00.000Z'),
    reclaimedCount: 1,
    ticketIds: ['bdboard-a'],
    ...overrides,
  };
}

describe('createReclaimHistory', () => {
  it('starts empty and exposes the start time', () => {
    const startedAt = new Date('2026-08-01T00:00:00.000Z');
    const history = createReclaimHistory({ startedAt });

    expect(history.list()).toEqual([]);
    expect(history.since()).toBe(startedAt);
    expect(history.unparsedRunCount()).toBe(0);
  });

  it('keeps runs that reclaimed something, in insertion order', () => {
    const history = createReclaimHistory();
    const first = run({ ticketIds: ['bdboard-a'] });
    const second = run({ ticketIds: ['bdboard-b'] });

    history.record(first);
    history.record(second);

    expect(history.list()).toEqual([first, second]);
  });

  it('drops no-op runs so the buffer is not filled by idle cycles', () => {
    const history = createReclaimHistory();
    history.record(run({ reclaimedCount: 0, ticketIds: [] }));

    expect(history.list()).toEqual([]);
  });

  it('does not buffer a run whose output could not be parsed, but counts it', () => {
    const history = createReclaimHistory();
    history.record(run({ reclaimedCount: null, ticketIds: [] }));
    history.record(run({ reclaimedCount: null, ticketIds: [] }));

    expect(history.list()).toEqual([]);
    expect(history.unparsedRunCount()).toBe(2);
  });

  it('drops the real bd idle output instead of buffering it as a firing', () => {
    // 実出力そのまま。これが count=null で積まれると 5 分ごとの空振りが
    // 1 日 288 件たまり、本物の reclaim を押し出してしまう (レビュー B1)。
    const parsed = parseReclaimStdout(IDLE_STDOUT);
    expect(parsed.count).toBe(0);

    const history = createReclaimHistory({ maxEntries: 3 });
    const real = run({ ticketIds: ['bdboard-real'] });
    history.record(real);
    for (let index = 0; index < 10; index += 1) {
      history.record(
        run({ reclaimedCount: parsed.count, ticketIds: [...parsed.ticketIds] }),
      );
    }

    expect(history.list()).toEqual([real]);
    expect(history.unparsedRunCount()).toBe(0);
  });

  it('keeps a run that reported ids but no parseable count', () => {
    const history = createReclaimHistory();
    const withIds = run({ reclaimedCount: 0, ticketIds: ['bdboard-a'] });
    history.record(withIds);

    expect(history.list()).toEqual([withIds]);
  });

  it('evicts the oldest entries beyond the limit', () => {
    const history = createReclaimHistory({ maxEntries: 3 });
    for (let index = 0; index < 5; index += 1) {
      history.record(run({ ticketIds: [`bdboard-${index}`] }));
    }

    expect(history.list().map((entry) => entry.ticketIds[0])).toEqual([
      'bdboard-2',
      'bdboard-3',
      'bdboard-4',
    ]);
  });

  it('reports the oldest buffered run as `since` once entries were evicted', () => {
    const startedAt = new Date('2026-08-01T00:00:00.000Z');
    const history = createReclaimHistory({ maxEntries: 2, startedAt });

    history.record(run({ at: new Date('2026-08-02T00:00:00.000Z') }));
    expect(history.since()).toBe(startedAt);

    history.record(run({ at: new Date('2026-08-03T00:00:00.000Z') }));
    expect(history.since()).toBe(startedAt);

    history.record(run({ at: new Date('2026-08-04T00:00:00.000Z') }));
    // 溢れた後は起動時刻ではなく、残っている最古の実行時刻を返す。
    expect(history.since()).toEqual(new Date('2026-08-03T00:00:00.000Z'));
  });

  it('defaults to a 500-entry buffer', () => {
    const history = createReclaimHistory();
    for (let index = 0; index < DEFAULT_RECLAIM_HISTORY_LIMIT + 10; index += 1) {
      history.record(run({ ticketIds: [`bdboard-${index}`] }));
    }

    expect(history.list()).toHaveLength(DEFAULT_RECLAIM_HISTORY_LIMIT);
    expect(history.list()[0]?.ticketIds[0]).toBe('bdboard-10');
  });

  it('returns a copy so callers cannot mutate the buffer', () => {
    const history = createReclaimHistory();
    history.record(run());

    const listed = history.list() as ReclaimRunRecord[];
    listed.push(run({ projectId: 'proj-b' }));

    expect(history.list()).toHaveLength(1);
  });
});
