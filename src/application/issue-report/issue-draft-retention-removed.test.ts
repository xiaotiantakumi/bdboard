import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftFootprint } from '../../domain/issue-draft-retention.js';
import type { DraftSurvey, IssueDraftStoragePort } from '../ports/issue-draft-storage.js';
import { createDraftRetention } from './issue-draft-retention.js';

/**
 * bdboard-vsuc: 掃除・容量の削除が消せた id を onRemoved で知らせる (受け取りの索引から落とすため)。
 * issue-draft-retention.test.ts と同じ stub の保存先で、削除の成否を 1 件ずつ決める。
 */

const NOW = new Date('2026-10-04T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_1 = '1-aaaaaaaaaaaaaaaa';
const ID_2 = '2-bbbbbbbbbbbbbbbb';

function dismissedFootprint(id: string, ageDays: number, bytes: number): DraftFootprint {
  return { id, bytes, known: { status: 'dismissed', updatedAtMs: NOW.getTime() - ageDays * DAY_MS } };
}

function stubStorage(survey: DraftSurvey) {
  return {
    survey: vi.fn<IssueDraftStoragePort['survey']>().mockResolvedValue(survey),
    remove: vi.fn<IssueDraftStoragePort['remove']>().mockResolvedValue(undefined),
  };
}

const expired = (): DraftSurvey => ({ drafts: [dismissedFootprint(ID_1, 40, 20), dismissedFootprint(ID_2, 40, 20)], totalBytes: 40, unmeasured: [] });

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('createDraftRetention onRemoved', () => {
  it('passes the ids of the expired drafts that were removed, once, before onPruned', async () => {
    const storage = stubStorage(expired());
    const calls: string[] = [];
    const onRemoved = vi.fn(() => {
      calls.push('removed');
    });
    const onPruned = vi.fn(() => {
      calls.push('pruned');
    });
    const retention = createDraftRetention({ storage, now: () => NOW, onRemoved, onPruned });
    await retention.pruneNow();
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith(new Set([ID_1, ID_2]));
    expect(calls).toEqual(['removed', 'pruned']);
  });

  it('passes only the ids that could be removed', async () => {
    const storage = stubStorage(expired());
    storage.remove.mockImplementation((id) => (id === ID_1 ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : Promise.resolve()));
    const onRemoved = vi.fn();
    const retention = createDraftRetention({ storage, now: () => NOW, onRemoved, warn: () => undefined });
    await retention.pruneNow();
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith(new Set([ID_2]));
  });

  it('is not called when nothing was removed (nothing expired, or every removal failed)', async () => {
    const fresh: DraftSurvey = { drafts: [dismissedFootprint(ID_1, 1, 20)], totalBytes: 20, unmeasured: [] };
    const onRemoved = vi.fn();
    await createDraftRetention({ storage: stubStorage(fresh), now: () => NOW, onRemoved }).pruneNow();
    expect(onRemoved).not.toHaveBeenCalled();

    const stuck = stubStorage(expired());
    stuck.remove.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    await createDraftRetention({ storage: stuck, now: () => NOW, onRemoved, warn: () => undefined }).pruneNow();
    expect(stuck.remove).toHaveBeenCalledTimes(2);
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('is not called when the survey fails', async () => {
    const storage = stubStorage(expired());
    storage.survey.mockRejectedValue(Object.assign(new Error('failed'), { code: 'EIO' }));
    const onRemoved = vi.fn();
    await createDraftRetention({ storage, now: () => NOW, onRemoved, warn: () => undefined }).pruneNow();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('is also called for the drafts removed to make room under the size cap', async () => {
    const storage = stubStorage({ drafts: [dismissedFootprint(ID_1, 9, 60), dismissedFootprint(ID_2, 5, 60)], totalBytes: 120, unmeasured: [] });
    const onRemoved = vi.fn();
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 120, onRemoved });
    expect(await retention.ensureRoom(60)).toBe(true);
    expect(storage.remove).toHaveBeenCalledWith(ID_1);
    expect(onRemoved).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith(new Set([ID_1]));
  });

  it.each([
    ['throws', () => { throw Object.assign(new Error('example-user private message'), { code: 'EFAULT' }); }],
    ['rejects', () => Promise.reject(Object.assign(new Error('example-user private message'), { code: 'EFAULT' }))],
  ])('does not fail the prune when onRemoved %s: one code-only warning, and onPruned still runs', async (_how, behavior) => {
    const storage = stubStorage(expired());
    const warn = vi.fn();
    const onPruned = vi.fn();
    const retention = createDraftRetention({ storage, now: () => NOW, onRemoved: vi.fn(behavior), onPruned, warn });
    await expect(retention.pruneNow()).resolves.toBeUndefined();
    expect(storage.remove).toHaveBeenCalledTimes(2);
    expect(onPruned).toHaveBeenCalledWith(expect.anything(), new Set([ID_1, ID_2]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('issue draft index could not drop removed drafts (EFAULT)');
  });

  it('does not fail ensureRoom when onRemoved throws', async () => {
    const storage = stubStorage({ drafts: [dismissedFootprint(ID_1, 9, 60), dismissedFootprint(ID_2, 5, 60)], totalBytes: 120, unmeasured: [] });
    const warn = vi.fn();
    const onRemoved = vi.fn(() => {
      throw new Error('index gone');
    });
    const retention = createDraftRetention({ storage, now: () => NOW, maxTotalBytes: 120, onRemoved, warn });
    expect(await retention.ensureRoom(60)).toBe(true);
    expect(warn).toHaveBeenCalledWith('issue draft index could not drop removed drafts (unknown)');
  });
});
