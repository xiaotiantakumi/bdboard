import { describe, expect, it } from 'vitest';
import type { ReclaimRunRecord } from '../../domain/harness-kpi.js';
import { createReclaimHistory, DEFAULT_RECLAIM_HISTORY_LIMIT } from './reclaim-history.js';

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
    expect(history.startedAt).toBe(startedAt);
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

  it('keeps a run whose count could not be parsed', () => {
    const history = createReclaimHistory();
    const unknown = run({ reclaimedCount: null, ticketIds: [] });
    history.record(unknown);

    expect(history.list()).toEqual([unknown]);
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
