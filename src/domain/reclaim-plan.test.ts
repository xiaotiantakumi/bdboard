import { describe, expect, it } from 'vitest';
import {
  planReclaim,
  WORKTREE_PROTECTION_CAP_MS,
  type ReclaimPlanCandidate,
} from './reclaim-plan.js';

const NOW = new Date('2026-09-05T12:00:00Z');

function candidate(overrides: Partial<ReclaimPlanCandidate> = {}): ReclaimPlanCandidate {
  return {
    ticketId: 'bdboard-live',
    startedAt: new Date(NOW.getTime() - 20 * 60_000),
    hasLiveWorktree: true,
    ...overrides,
  };
}

describe('planReclaim', () => {
  // 2026-09-05 の実事象 (bdboard-okdh / 53my / s0o7 / s1vj)。claim の 15〜19 分後に
  // 回収された。worktree は残っていたので、この関数が入っていれば全件守られる。
  it('protects tickets that still have a worktree', () => {
    const plan = planReclaim([candidate()], NOW);

    expect(plan.protectedTicketIds).toEqual(['bdboard-live']);
    expect(plan.reclaimTicketIds).toEqual([]);
  });

  it('reclaims tickets with no worktree evidence', () => {
    const plan = planReclaim([candidate({ hasLiveWorktree: false })], NOW);

    expect(plan.reclaimTicketIds).toEqual(['bdboard-live']);
    expect(plan.protectedTicketIds).toEqual([]);
  });

  // 保護に上限を置かないと、掃除し損ねた worktree が残っているだけのチケットが
  // 永久に in_progress で塩漬けになる — reclaim が防いでいた失敗形そのもの。
  it('stops protecting once the cap has passed', () => {
    const plan = planReclaim(
      [candidate({ startedAt: new Date(NOW.getTime() - WORKTREE_PROTECTION_CAP_MS - 1) })],
      NOW,
    );

    expect(plan.reclaimTicketIds).toEqual(['bdboard-live']);
    expect(plan.protectedTicketIds).toEqual([]);
  });

  it('still protects exactly at the cap boundary', () => {
    const plan = planReclaim(
      [candidate({ startedAt: new Date(NOW.getTime() - WORKTREE_PROTECTION_CAP_MS) })],
      NOW,
    );

    expect(plan.protectedTicketIds).toEqual(['bdboard-live']);
  });

  it('splits a mixed set and keeps every ticket in exactly one bucket', () => {
    const plan = planReclaim(
      [
        candidate({ ticketId: 'a', hasLiveWorktree: true }),
        candidate({ ticketId: 'b', hasLiveWorktree: false }),
        candidate({
          ticketId: 'c',
          hasLiveWorktree: true,
          startedAt: new Date(NOW.getTime() - 2 * WORKTREE_PROTECTION_CAP_MS),
        }),
      ],
      NOW,
    );

    expect(plan.protectedTicketIds).toEqual(['a']);
    expect(plan.reclaimTicketIds).toEqual(['b', 'c']);
  });

  it('returns empty lists for no candidates', () => {
    const plan = planReclaim([], NOW);

    expect(plan.reclaimTicketIds).toEqual([]);
    expect(plan.protectedTicketIds).toEqual([]);
  });

  // 上限そのものが実作業時間より十分長いこと。短くすると保護が意味を失う。
  it('caps protection well above a realistic ticket duration', () => {
    const observedMedianMs = 186 * 60_000;
    expect(WORKTREE_PROTECTION_CAP_MS).toBeGreaterThan(observedMedianMs * 3);
  });
});
