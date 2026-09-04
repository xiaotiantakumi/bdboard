import { describe, expect, it } from 'vitest';
import {
  computeDuplicateMentionShare,
  computeHarnessKpi,
  computeHarnessLabeledShare,
  computePendingDecisionDwell,
  computeReclaimKpi,
  hasHarnessLabel,
  isPendingDecisionTicket,
  mentionsDuplicate,
  percentileMs,
  RECLAIM_RECLAIM_WINDOW_MS,
  type HarnessKpiRange,
  type ReclaimRunRecord,
} from './harness-kpi.js';
import { makeTicket } from './test-support.js';

const HOUR_MS = 60 * 60_000;

// テストは常にタイムゾーンに依存しない絶対時刻 (UTC の ISO 文字列) で書く。
// KPI 側は Date しか見ないので、CI (TZ=UTC) とローカルで結果が変わらない。
const RANGE: HarnessKpiRange = {
  start: new Date('2026-08-01T00:00:00.000Z'),
  end: new Date('2026-09-01T00:00:00.000Z'),
};

function at(iso: string): Date {
  return new Date(iso);
}

describe('percentileMs', () => {
  it('returns null for an empty sample', () => {
    expect(percentileMs([], 0.5)).toBeNull();
    expect(percentileMs([], 0.9)).toBeNull();
  });

  it('returns the only value for a single sample', () => {
    expect(percentileMs([42], 0.5)).toBe(42);
    expect(percentileMs([42], 0.9)).toBe(42);
  });

  it('averages the two middle values for an even sample', () => {
    expect(percentileMs([10, 30], 0.5)).toBe(20);
    expect(percentileMs([10, 20, 30, 40], 0.5)).toBe(25);
  });

  it('interpolates and rounds p90 to whole milliseconds', () => {
    // rank = (10-1)*0.9 = 8.1 → 90 + (100-90)*0.1 = 91
    expect(percentileMs([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)).toBe(91);
    // rank = (3-1)*0.9 = 1.8 → 1 + (2-1)*0.8 = 1.8 → 2 (四捨五入)
    expect(percentileMs([0, 1, 2], 0.9)).toBe(2);
  });

  it('clamps out-of-range percentiles to the sample bounds', () => {
    expect(percentileMs([5, 15], -1)).toBe(5);
    expect(percentileMs([5, 15], 2)).toBe(15);
  });
});

describe('isPendingDecisionTicket', () => {
  it('matches the human label and the gate issue type', () => {
    expect(isPendingDecisionTicket(makeTicket({ labels: ['human'] }))).toBe(true);
    expect(isPendingDecisionTicket(makeTicket({ issueType: 'gate' }))).toBe(true);
  });

  it('does not match plain tickets', () => {
    expect(isPendingDecisionTicket(makeTicket())).toBe(false);
    expect(isPendingDecisionTicket(makeTicket({ labels: ['harness'] }))).toBe(false);
  });
});

describe('hasHarnessLabel', () => {
  it('matches harness and harness-upstream', () => {
    expect(hasHarnessLabel(makeTicket({ labels: ['harness'] }))).toBe(true);
    expect(hasHarnessLabel(makeTicket({ labels: ['a', 'harness-upstream'] }))).toBe(true);
  });

  it('does not match other labels or a missing label list', () => {
    expect(hasHarnessLabel(makeTicket({ labels: ['human'] }))).toBe(false);
    expect(hasHarnessLabel(makeTicket())).toBe(false);
  });
});

describe('mentionsDuplicate', () => {
  it('matches the duplicate keywords in title or description', () => {
    expect(mentionsDuplicate(makeTicket({ title: '重複ヘルパーの統合' }))).toBe(true);
    expect(mentionsDuplicate(makeTicket({ title: 'x', description: 'Duplicate impl' }))).toBe(
      true,
    );
    expect(mentionsDuplicate(makeTicket({ title: '再発したバグ' }))).toBe(true);
    expect(mentionsDuplicate(makeTicket({ title: '二重登録' }))).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(mentionsDuplicate(makeTicket({ title: '統計タブを直す' }))).toBe(false);
  });

  it('is not affected by regex lastIndex across repeated calls', () => {
    const ticket = makeTicket({ title: '重複' });
    expect(mentionsDuplicate(ticket)).toBe(true);
    expect(mentionsDuplicate(ticket)).toBe(true);
  });
});

describe('computePendingDecisionDwell', () => {
  it('returns an empty result for no tickets', () => {
    expect(computePendingDecisionDwell([], RANGE)).toEqual({
      closedCount: 0,
      closedGateCount: 0,
      closedWorkCount: 0,
      openCount: 0,
      openGateCount: 0,
      openWorkCount: 0,
      medianMs: null,
      p90Ms: null,
      anchor: 'created',
    });
  });

  it('measures created → closed for human-labeled and gate tickets', () => {
    const tickets = [
      makeTicket({
        id: 'a',
        labels: ['human'],
        createdAt: at('2026-08-10T00:00:00.000Z'),
        closedAt: at('2026-08-10T01:00:00.000Z'),
      }),
      makeTicket({
        id: 'b',
        issueType: 'gate',
        createdAt: at('2026-08-11T00:00:00.000Z'),
        closedAt: at('2026-08-11T03:00:00.000Z'),
      }),
      // 確認待ちでないので無視される
      makeTicket({
        id: 'c',
        createdAt: at('2026-08-12T00:00:00.000Z'),
        closedAt: at('2026-08-20T00:00:00.000Z'),
      }),
    ];

    expect(computePendingDecisionDwell(tickets, RANGE)).toEqual({
      closedCount: 2,
      closedGateCount: 1,
      closedWorkCount: 1,
      openCount: 0,
      openGateCount: 0,
      openWorkCount: 0,
      medianMs: 2 * HOUR_MS,
      p90Ms: Math.round(1 * HOUR_MS + 2 * HOUR_MS * 0.9),
      anchor: 'created',
    });
  });

  it('splits open counts into gate and human-labeled work tickets', () => {
    const tickets = [
      makeTicket({ id: 'g1', issueType: 'gate', createdAt: at('2026-08-10T00:00:00.000Z') }),
      makeTicket({ id: 'g2', issueType: 'gate', createdAt: at('2026-08-10T00:00:00.000Z') }),
      makeTicket({ id: 'w1', labels: ['human'], createdAt: at('2026-08-10T00:00:00.000Z') }),
    ];

    expect(computePendingDecisionDwell(tickets, RANGE)).toMatchObject({
      openCount: 3,
      openGateCount: 2,
      openWorkCount: 1,
    });
  });

  it('does not count a work ticket whose human label was released without closing', () => {
    // bdboard-xgvh 以降、作業チケットへの回答は human ラベルを外すだけでクローズしない。
    // その結果このチケットは確認待ちとして扱われず、closed 側にも open 側にも入らない。
    const answered = makeTicket({
      id: 'w1',
      labels: [],
      createdAt: at('2026-08-10T00:00:00.000Z'),
    });

    expect(computePendingDecisionDwell([answered], RANGE)).toMatchObject({
      closedCount: 0,
      closedWorkCount: 0,
      openCount: 0,
      openWorkCount: 0,
    });
  });

  it('excludes closes outside the range but keeps open tickets regardless of range', () => {
    const tickets = [
      makeTicket({
        id: 'old',
        labels: ['human'],
        createdAt: at('2026-07-01T00:00:00.000Z'),
        closedAt: at('2026-07-02T00:00:00.000Z'),
      }),
      makeTicket({
        id: 'open-old',
        labels: ['human'],
        createdAt: at('2026-01-01T00:00:00.000Z'),
      }),
    ];

    const result = computePendingDecisionDwell(tickets, RANGE);
    expect(result.closedCount).toBe(0);
    expect(result.openCount).toBe(1);
    expect(result.medianMs).toBeNull();
  });

  it('includes closes exactly on the range boundaries', () => {
    const tickets = [
      makeTicket({
        id: 'start',
        labels: ['human'],
        createdAt: at('2026-07-31T23:00:00.000Z'),
        closedAt: RANGE.start,
      }),
      makeTicket({
        id: 'end',
        labels: ['human'],
        createdAt: at('2026-08-31T23:00:00.000Z'),
        closedAt: RANGE.end,
      }),
    ];

    expect(computePendingDecisionDwell(tickets, RANGE).closedCount).toBe(2);
  });

  it('clamps a close that precedes creation to zero instead of going negative', () => {
    const tickets = [
      makeTicket({
        id: 'skewed',
        labels: ['human'],
        createdAt: at('2026-08-10T02:00:00.000Z'),
        closedAt: at('2026-08-10T01:00:00.000Z'),
      }),
    ];

    expect(computePendingDecisionDwell(tickets, RANGE).medianMs).toBe(0);
  });
});

describe('computeReclaimKpi', () => {
  const projectId = '/projects/bdboard';

  function run(overrides: Partial<ReclaimRunRecord> = {}): ReclaimRunRecord {
    return {
      projectId,
      at: at('2026-08-10T00:00:00.000Z'),
      reclaimedCount: 1,
      ticketIds: ['bdboard-a'],
      ...overrides,
    };
  }

  it('returns an empty result for no runs', () => {
    expect(computeReclaimKpi([], [], RANGE)).toEqual({
      runCount: 0,
      reclaimedCountTotal: 0,
      unknownCountRunCount: 0,
      identifiedTicketCount: 0,
      reclaimedThenInProgressCount: 0,
      reclaimedThenInProgressRate: null,
      windowMs: RECLAIM_RECLAIM_WINDOW_MS,
    });
  });

  it('counts a re-claim inside the window and ignores one outside it', () => {
    const runs = [
      run({ ticketIds: ['bdboard-a'] }),
      run({ ticketIds: ['bdboard-b'] }),
    ];
    const tickets = [
      makeTicket({
        id: 'bdboard-a',
        projectId,
        // reclaim の 10 分後に再 claim → 誤回収の疑い
        startedAt: at('2026-08-10T00:10:00.000Z'),
      }),
      makeTicket({
        id: 'bdboard-b',
        projectId,
        // 31 分後なので窓の外
        startedAt: at('2026-08-10T00:31:00.000Z'),
      }),
    ];

    const result = computeReclaimKpi(runs, tickets, RANGE);
    expect(result.runCount).toBe(2);
    expect(result.reclaimedCountTotal).toBe(2);
    expect(result.identifiedTicketCount).toBe(2);
    expect(result.reclaimedThenInProgressCount).toBe(1);
    expect(result.reclaimedThenInProgressRate).toBe(0.5);
  });

  it('treats the window edge as inclusive and a re-claim at the reclaim instant as excluded', () => {
    const tickets = [
      makeTicket({
        id: 'bdboard-edge',
        projectId,
        startedAt: at('2026-08-10T00:30:00.000Z'),
      }),
      makeTicket({
        id: 'bdboard-same',
        projectId,
        startedAt: at('2026-08-10T00:00:00.000Z'),
      }),
    ];

    expect(
      computeReclaimKpi([run({ ticketIds: ['bdboard-edge'] })], tickets, RANGE)
        .reclaimedThenInProgressCount,
    ).toBe(1);
    expect(
      computeReclaimKpi([run({ ticketIds: ['bdboard-same'] })], tickets, RANGE)
        .reclaimedThenInProgressCount,
    ).toBe(0);
  });

  it('drops ids that match no ticket so misparsed tokens do not skew the rate', () => {
    const runs = [run({ ticketIds: ['older-than', 'bdboard-a'] })];
    const tickets = [
      makeTicket({
        id: 'bdboard-a',
        projectId,
        startedAt: at('2026-08-10T00:05:00.000Z'),
      }),
    ];

    const result = computeReclaimKpi(runs, tickets, RANGE);
    expect(result.identifiedTicketCount).toBe(1);
    expect(result.reclaimedThenInProgressRate).toBe(1);
  });

  it('does not join ids across projects', () => {
    const runs = [run({ projectId: '/projects/other' })];
    const tickets = [
      makeTicket({
        id: 'bdboard-a',
        projectId,
        startedAt: at('2026-08-10T00:05:00.000Z'),
      }),
    ];

    const result = computeReclaimKpi(runs, tickets, RANGE);
    expect(result.runCount).toBe(1);
    expect(result.identifiedTicketCount).toBe(0);
    expect(result.reclaimedThenInProgressRate).toBeNull();
  });

  it('deduplicates repeated ids within one run', () => {
    const runs = [run({ ticketIds: ['bdboard-a', 'bdboard-a'] })];
    const tickets = [makeTicket({ id: 'bdboard-a', projectId })];

    expect(computeReclaimKpi(runs, tickets, RANGE).identifiedTicketCount).toBe(1);
  });

  it('counts runs whose count could not be parsed separately', () => {
    const runs = [run({ reclaimedCount: null, ticketIds: [] }), run()];

    const result = computeReclaimKpi(runs, [], RANGE);
    expect(result.runCount).toBe(2);
    expect(result.unknownCountRunCount).toBe(1);
    expect(result.reclaimedCountTotal).toBe(1);
  });

  it('ignores runs outside the range', () => {
    const runs = [run({ at: at('2026-07-01T00:00:00.000Z') })];
    expect(computeReclaimKpi(runs, [], RANGE).runCount).toBe(0);
  });

  it('honours a custom window', () => {
    const runs = [run()];
    const tickets = [
      makeTicket({
        id: 'bdboard-a',
        projectId,
        startedAt: at('2026-08-10T00:10:00.000Z'),
      }),
    ];

    expect(computeReclaimKpi(runs, tickets, RANGE, 5 * 60_000)).toMatchObject({
      reclaimedThenInProgressCount: 0,
      windowMs: 5 * 60_000,
    });
  });
});

describe('computeHarnessLabeledShare / computeDuplicateMentionShare', () => {
  it('returns a null rate for an empty period', () => {
    expect(computeHarnessLabeledShare([], RANGE)).toEqual({
      matchedCount: 0,
      totalCount: 0,
      rate: null,
    });
    expect(computeDuplicateMentionShare([], RANGE)).toEqual({
      matchedCount: 0,
      totalCount: 0,
      rate: null,
    });
  });

  it('counts only tickets created inside the period', () => {
    const tickets = [
      makeTicket({ id: 'a', labels: ['harness'], createdAt: at('2026-08-05T00:00:00.000Z') }),
      makeTicket({ id: 'b', createdAt: at('2026-08-06T00:00:00.000Z') }),
      makeTicket({ id: 'c', labels: ['harness'], createdAt: at('2026-07-05T00:00:00.000Z') }),
    ];

    expect(computeHarnessLabeledShare(tickets, RANGE)).toEqual({
      matchedCount: 1,
      totalCount: 2,
      rate: 0.5,
    });
  });

  it('counts duplicate mentions over the same denominator', () => {
    const tickets = [
      makeTicket({ id: 'a', title: '重複実装の統合', createdAt: at('2026-08-05T00:00:00.000Z') }),
      makeTicket({ id: 'b', title: 'ふつうの修正', createdAt: at('2026-08-06T00:00:00.000Z') }),
      makeTicket({
        id: 'c',
        title: 'ふつう',
        description: 'duplicate helper',
        createdAt: at('2026-08-07T00:00:00.000Z'),
      }),
      makeTicket({ id: 'd', title: '範囲外', createdAt: at('2026-09-02T00:00:00.000Z') }),
    ];

    expect(computeDuplicateMentionShare(tickets, RANGE)).toEqual({
      matchedCount: 2,
      totalCount: 3,
      rate: 2 / 3,
    });
  });
});

describe('computeHarnessKpi', () => {
  it('returns all four metrics with empty inputs', () => {
    expect(computeHarnessKpi({ tickets: [], range: RANGE })).toEqual({
      rangeStart: RANGE.start,
      rangeEnd: RANGE.end,
      pendingDecisionDwell: {
        closedCount: 0,
        closedGateCount: 0,
        closedWorkCount: 0,
        openCount: 0,
        openGateCount: 0,
        openWorkCount: 0,
        medianMs: null,
        p90Ms: null,
        anchor: 'created',
      },
      reclaim: {
        runCount: 0,
        reclaimedCountTotal: 0,
        unknownCountRunCount: 0,
        identifiedTicketCount: 0,
        reclaimedThenInProgressCount: 0,
        reclaimedThenInProgressRate: null,
        windowMs: RECLAIM_RECLAIM_WINDOW_MS,
      },
      harnessLabeled: { matchedCount: 0, totalCount: 0, rate: null },
      duplicateMention: { matchedCount: 0, totalCount: 0, rate: null },
    });
  });

  it('combines ticket and reclaim inputs', () => {
    const projectId = '/projects/bdboard';
    const tickets = [
      makeTicket({
        id: 'bdboard-a',
        projectId,
        labels: ['human', 'harness'],
        title: '重複の統合',
        createdAt: at('2026-08-10T00:00:00.000Z'),
        closedAt: at('2026-08-10T02:00:00.000Z'),
        startedAt: at('2026-08-10T00:05:00.000Z'),
      }),
    ];
    const reclaimRuns: ReclaimRunRecord[] = [
      {
        projectId,
        at: at('2026-08-10T00:00:00.000Z'),
        reclaimedCount: 1,
        ticketIds: ['bdboard-a'],
      },
    ];

    const kpi = computeHarnessKpi({ tickets, range: RANGE, reclaimRuns });
    expect(kpi.pendingDecisionDwell.closedCount).toBe(1);
    expect(kpi.pendingDecisionDwell.medianMs).toBe(2 * HOUR_MS);
    expect(kpi.reclaim.reclaimedThenInProgressRate).toBe(1);
    expect(kpi.harnessLabeled).toEqual({ matchedCount: 1, totalCount: 1, rate: 1 });
    expect(kpi.duplicateMention).toEqual({ matchedCount: 1, totalCount: 1, rate: 1 });
  });
});
