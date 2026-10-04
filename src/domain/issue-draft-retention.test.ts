import { describe, expect, it } from 'vitest';
import {
  ISSUE_DRAFT_DIR_MAX_BYTES,
  ISSUE_DRAFT_PRUNE_INTERVAL_MS,
  ISSUE_DRAFT_RESURVEY_GAP_MAX_MS,
  ISSUE_DRAFT_RESURVEY_GAP_MS,
  ISSUE_DRAFT_RETENTION_MS,
  isTerminalDraftStatus,
  selectDraftsToFree,
  selectExpiredDrafts,
  type DraftFootprint,
} from './issue-draft-retention.js';
import type { DraftStatus } from './issue-draft.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-10-04T12:00:00.000Z');

function footprint(id: string, status: DraftStatus | undefined, ageMs: number, bytes = 100): DraftFootprint {
  return status === undefined
    ? { id, bytes }
    : { id, bytes, known: { status, updatedAtMs: NOW_MS - ageMs } };
}

describe('the pinned limits (bdboard-00qh)', () => {
  it('keeps terminal drafts 30 days, prunes at most hourly, re-measures at most per minute and caps the directory at 1 GiB', () => {
    expect(ISSUE_DRAFT_RETENTION_MS).toBe(30 * DAY_MS);
    expect(ISSUE_DRAFT_PRUNE_INTERVAL_MS).toBe(3_600_000);
    expect(ISSUE_DRAFT_RESURVEY_GAP_MS).toBe(60_000);
    expect(ISSUE_DRAFT_RESURVEY_GAP_MAX_MS).toBe(3_600_000); // 張り付いたあとの測り直しの間隔の上限 (bdboard-krvf)
    expect(ISSUE_DRAFT_DIR_MAX_BYTES).toBe(1_073_741_824);
  });
});

describe('isTerminalDraftStatus', () => {
  it('is true for dismissed and posted, false for pending', () => {
    expect(isTerminalDraftStatus('dismissed')).toBe(true);
    expect(isTerminalDraftStatus('posted')).toBe(true);
    expect(isTerminalDraftStatus('pending')).toBe(false);
  });
});

describe('selectExpiredDrafts', () => {
  const ids = (drafts: readonly DraftFootprint[]) => drafts.map((draft) => draft.id);

  it('selects a terminal draft only when it is strictly older than the retention period', () => {
    const drafts = [
      footprint('under', 'dismissed', ISSUE_DRAFT_RETENTION_MS - 1),
      footprint('exact', 'dismissed', ISSUE_DRAFT_RETENTION_MS),
      footprint('over', 'dismissed', ISSUE_DRAFT_RETENTION_MS + 1),
    ];
    expect(ids(selectExpiredDrafts(drafts, NOW_MS, ISSUE_DRAFT_RETENTION_MS))).toEqual(['over']);
  });

  it('selects posted the same way as dismissed', () => {
    const drafts = [
      footprint('posted-old', 'posted', 31 * DAY_MS),
      footprint('posted-new', 'posted', 29 * DAY_MS),
    ];
    expect(ids(selectExpiredDrafts(drafts, NOW_MS, ISSUE_DRAFT_RETENTION_MS))).toEqual(['posted-old']);
  });

  it('never selects a pending draft, however old', () => {
    const drafts = [footprint('open', 'pending', 3650 * DAY_MS)];
    expect(selectExpiredDrafts(drafts, NOW_MS, ISSUE_DRAFT_RETENTION_MS)).toEqual([]);
  });

  it('never selects a draft whose status is unknown (unreadable), however large the retention overrun looks', () => {
    const drafts = [footprint('unreadable', undefined, 3650 * DAY_MS)];
    expect(selectExpiredDrafts(drafts, NOW_MS, ISSUE_DRAFT_RETENTION_MS)).toEqual([]);
  });

  it('does not select a draft stamped in the future (clock skew)', () => {
    expect(selectExpiredDrafts([footprint('future', 'dismissed', -DAY_MS)], NOW_MS, ISSUE_DRAFT_RETENTION_MS)).toEqual([]);
  });
});

describe('selectDraftsToFree', () => {
  it('takes terminal drafts oldest first until enough bytes are freed', () => {
    const drafts = [
      footprint('newer', 'dismissed', 1 * DAY_MS, 50),
      footprint('oldest', 'dismissed', 9 * DAY_MS, 50),
      footprint('open', 'pending', 99 * DAY_MS, 1000),
      footprint('middle', 'posted', 5 * DAY_MS, 50),
    ];
    expect(selectDraftsToFree(drafts, 60)?.map((draft) => draft.id)).toEqual(['oldest', 'middle']);
    expect(selectDraftsToFree(drafts, 50)?.map((draft) => draft.id)).toEqual(['oldest']);
  });

  it('returns an empty list when nothing needs freeing', () => {
    expect(selectDraftsToFree([footprint('a', 'dismissed', DAY_MS)], 0)).toEqual([]);
    expect(selectDraftsToFree([], -5)).toEqual([]);
  });

  it('returns undefined, choosing nothing, when even every terminal draft would not free enough', () => {
    const drafts = [
      footprint('a', 'dismissed', DAY_MS, 40),
      footprint('b', 'dismissed', 2 * DAY_MS, 40),
      footprint('open', 'pending', 3 * DAY_MS, 10_000),
    ];
    expect(selectDraftsToFree(drafts, 81)).toBeUndefined();
    expect(selectDraftsToFree(drafts, 80)?.map((draft) => draft.id)).toEqual(['b', 'a']);
  });

  it('never chooses a pending or unknown-status draft', () => {
    const drafts = [footprint('open', 'pending', 99 * DAY_MS, 1000), footprint('unreadable', undefined, 99 * DAY_MS, 1000)];
    expect(selectDraftsToFree(drafts, 1)).toBeUndefined();
  });

  it('breaks a tie in age by id so the order is deterministic', () => {
    const drafts = [footprint('b', 'dismissed', DAY_MS, 10), footprint('a', 'dismissed', DAY_MS, 10)];
    expect(selectDraftsToFree(drafts, 10)?.map((draft) => draft.id)).toEqual(['a']);
  });
});
