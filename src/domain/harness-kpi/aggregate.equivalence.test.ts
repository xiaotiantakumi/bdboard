import { describe, expect, it } from 'vitest';
import type { LeftoverCandidate } from '../git-worktree.js';
import { hasLiveWorktreeEvidence } from '../hygiene.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';
import { makeTicket } from '../test-support.js';
import { computeHarnessKpi, createHarnessKpiAccumulator } from './aggregate.js';
import { percentileMs } from './percentile.js';
import { isPendingDecisionTicket } from './pending-decision.js';
import { isInRange } from './shared.js';
import { hasHarnessLabel, mentionsDuplicate } from './share.js';
import {
  PENDING_DECISION_ISSUE_TYPE,
  RECLAIM_RECLAIM_WINDOW_MS,
  type ComputeHarnessKpiInput,
  type HarnessKpi,
  type HarnessKpiRange,
  type HarnessShareKpi,
  type PendingDecisionDwellKpi,
  type ReclaimKpi,
  type ReclaimRunRecord,
} from './types.js';

// bdboard-kuui: computeHarnessKpi を accumulator (add / finish) 方式に作り替えたことで
// KPI の出力が変わっていないことを確かめる。比較相手は、作り替え前の 4 回走査版
// (pending-decision.ts / reclaim.ts / share.ts / aggregate.ts のループ本体) の写し。
// 写しは origin/main のロジックをそのまま (コメントだけ省いて) コピーしたもの。本体側を
// あとで直したときに、この写しも一緒に直して「テストが通る」ようにしてしまうと、
// 比較の意味が無くなる。この参照実装と食い違ったら、まず本体側の変更が意図した
// 挙動変更かを疑うこと。
// 述語 (isPendingDecisionTicket / hasHarnessLabel / mentionsDuplicate)・期間判定・
// 分位点・生存判定は今回触っていない共通部品なので、本体のものをそのまま使う。

function referencePendingDecisionDwell(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
): PendingDecisionDwellKpi {
  const durations: number[] = [];
  let closedGateCount = 0;
  let closedWorkCount = 0;
  let openCount = 0;
  let openGateCount = 0;
  let openWorkCount = 0;

  for (const ticket of tickets) {
    if (!isPendingDecisionTicket(ticket)) {
      continue;
    }
    const isGate = ticket.issueType === PENDING_DECISION_ISSUE_TYPE;

    if (ticket.closedAt === undefined) {
      openCount += 1;
      if (isGate) {
        openGateCount += 1;
      } else {
        openWorkCount += 1;
      }
      continue;
    }

    if (!isInRange(ticket.closedAt, range)) {
      continue;
    }

    if (isGate) {
      closedGateCount += 1;
    } else {
      closedWorkCount += 1;
    }
    durations.push(Math.max(0, ticket.closedAt.getTime() - ticket.createdAt.getTime()));
  }

  durations.sort((a, b) => a - b);

  return {
    closedCount: durations.length,
    closedGateCount,
    closedWorkCount,
    openCount,
    openGateCount,
    openWorkCount,
    medianMs: percentileMs(durations, 0.5),
    p90Ms: percentileMs(durations, 0.9),
    anchor: 'created',
  };
}

function referenceShare(
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
  predicate: (ticket: Ticket) => boolean,
): HarnessShareKpi {
  let matchedCount = 0;
  let totalCount = 0;
  for (const ticket of tickets) {
    if (!isInRange(ticket.createdAt, range)) {
      continue;
    }
    totalCount += 1;
    if (predicate(ticket)) {
      matchedCount += 1;
    }
  }
  return {
    matchedCount,
    totalCount,
    rate: totalCount > 0 ? matchedCount / totalCount : null,
  };
}

function referenceTicketKey(projectId: string, ticketId: TicketId): string {
  return `${projectId}\u0000${ticketId}`;
}

function referenceReclaim(
  reclaimRuns: readonly ReclaimRunRecord[],
  tickets: readonly Ticket[],
  range: HarnessKpiRange,
  windowMs: number,
  leftoverCandidates: readonly LeftoverCandidate[],
): ReclaimKpi {
  const ticketIndex = new Map<string, Ticket>();
  for (const ticket of tickets) {
    ticketIndex.set(referenceTicketKey(ticket.projectId, ticket.id), ticket);
  }
  const liveWorktreeTicketKeys = new Set<string>();
  for (const candidate of leftoverCandidates) {
    if (hasLiveWorktreeEvidence(candidate)) {
      liveWorktreeTicketKeys.add(referenceTicketKey(candidate.projectId, candidate.ticketId));
    }
  }

  let runCount = 0;
  let reclaimedCountTotal = 0;
  let unknownCountRunCount = 0;
  let identifiedTicketCount = 0;
  let reclaimedThenInProgressCount = 0;
  let reclaimedLiveWorktreeCount = 0;

  for (const run of reclaimRuns) {
    if (!isInRange(run.at, range)) {
      continue;
    }
    runCount += 1;
    if (run.reclaimedCount === null) {
      unknownCountRunCount += 1;
    } else {
      reclaimedCountTotal += run.reclaimedCount;
    }

    const seen = new Set<TicketId>();
    for (const ticketId of run.ticketIds) {
      if (seen.has(ticketId)) {
        continue;
      }
      seen.add(ticketId);
      const ticket = ticketIndex.get(referenceTicketKey(run.projectId, ticketId));
      if (ticket === undefined) {
        continue;
      }
      identifiedTicketCount += 1;
      if (
        ticket.status === 'open' &&
        liveWorktreeTicketKeys.has(referenceTicketKey(run.projectId, ticketId))
      ) {
        reclaimedLiveWorktreeCount += 1;
      }
      const startedAt = ticket.startedAt;
      if (startedAt === undefined) {
        continue;
      }
      const delta = startedAt.getTime() - run.at.getTime();
      if (delta > 0 && delta <= windowMs) {
        reclaimedThenInProgressCount += 1;
      }
    }
  }

  return {
    runCount,
    reclaimedCountTotal,
    unknownCountRunCount,
    identifiedTicketCount,
    reclaimedThenInProgressCount,
    reclaimedThenInProgressRate:
      identifiedTicketCount > 0 ? reclaimedThenInProgressCount / identifiedTicketCount : null,
    reclaimedLiveWorktreeCount,
    reclaimedLiveWorktreeRate:
      identifiedTicketCount > 0 ? reclaimedLiveWorktreeCount / identifiedTicketCount : null,
    windowMs,
  };
}

/** 作り替え前の computeHarnessKpi (4 回走査) の写し。 */
function referenceComputeHarnessKpi(input: ComputeHarnessKpiInput): HarnessKpi {
  const { tickets, range } = input;
  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    pendingDecisionDwell: referencePendingDecisionDwell(tickets, range),
    reclaim: referenceReclaim(
      input.reclaimRuns ?? [],
      tickets,
      range,
      input.reclaimWindowMs ?? RECLAIM_RECLAIM_WINDOW_MS,
      input.leftoverCandidates ?? [],
    ),
    harnessLabeled: referenceShare(tickets, range, hasHarnessLabel),
    duplicateMention: referenceShare(tickets, range, mentionsDuplicate),
  };
}

// --- fixtures -------------------------------------------------------------------

const RANGE: HarnessKpiRange = {
  start: new Date('2026-08-01T00:00:00.000Z'),
  end: new Date('2026-09-01T00:00:00.000Z'),
};
const START = RANGE.start.getTime();
const END = RANGE.end.getTime();
const MINUTE_MS = 60_000;

function atMs(ms: number): Date {
  return new Date(ms);
}

/** 期間の境界をまたぐ時刻 (ミリ秒)。±1ms が isInRange の閉区間判定を突く。 */
const BOUNDARY_TIMES: readonly number[] = [
  START - 365 * 24 * 60 * MINUTE_MS,
  START - 1,
  START,
  START + 1,
  START + 10 * 24 * 60 * MINUTE_MS,
  END - 1,
  END,
  END + 1,
  END + 365 * 24 * 60 * MINUTE_MS,
];

/** 固定シードの線形合同法。fixture は実行のたびに同じ内容になる。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  if (values.length === 0) {
    throw new Error('pick() from an empty list');
  }
  // values に undefined が入ることがある (「フィールド無し」の選択肢) ので、
  // undefined かどうかではなく添字で範囲を保証する。
  return values[Math.floor(random() * values.length)];
}

const LABEL_SETS: readonly (readonly string[] | undefined)[] = [
  undefined,
  [],
  ['human'],
  ['harness'],
  ['harness-upstream'],
  ['human', 'harness'],
  ['feature', 'harness-upstream'],
  ['feature'],
];
const ISSUE_TYPES = ['task', 'gate', 'bug', 'epic', 'feature'];
const STATUSES = ['open', 'in_progress', 'closed', 'blocked', 'deferred'];
const TITLES = [
  'plain title',
  '重複チケットの統合',
  'Duplicate of bdboard-x',
  'DUPLICATE in caps',
  '再発した問題',
  '二重 claim',
  'nothing to see',
];
const DESCRIPTIONS: readonly (string | undefined)[] = [
  undefined,
  '',
  'no keywords here',
  'これは重複している',
  'looks like a duplicate',
  '統合した',
];
const COMPLEXITIES: readonly (string | undefined)[] = [undefined, 'low', 'high'];

const PROJECT_IDS = ['proj-a', 'proj-b', 'proj-c'];

function generateTickets(seed: number, count: number): Ticket[] {
  const random = createRandom(seed);
  const tickets: Ticket[] = [];
  for (let index = 0; index < count; index += 1) {
    const projectId = pick(random, PROJECT_IDS);
    const createdMs = pick(random, BOUNDARY_TIMES);
    const closedMs = random() < 0.5 ? undefined : pick(random, BOUNDARY_TIMES);
    const startedMs = random() < 0.5 ? undefined : pick(random, BOUNDARY_TIMES);
    const labels = pick(random, LABEL_SETS);
    const description = pick(random, DESCRIPTIONS);
    const complexity = pick(random, COMPLEXITIES);
    tickets.push(
      makeTicket({
        // 一部は別プロジェクトと短い ID を共有させる (突き合わせは projectId も見る)。
        id: random() < 0.3 ? `bdboard-shared-${index % 7}` : `bdboard-${projectId}-${index}`,
        projectId,
        title: pick(random, TITLES),
        status: pick(random, STATUSES),
        issueType: pick(random, ISSUE_TYPES),
        createdAt: atMs(createdMs),
        ...(closedMs !== undefined ? { closedAt: atMs(closedMs) } : {}),
        ...(startedMs !== undefined ? { startedAt: atMs(startedMs) } : {}),
        ...(labels !== undefined ? { labels } : {}),
        ...(description !== undefined ? { description } : {}),
        // KPI が見ないメタデータ由来のフィールド。値が違っても出力は変わらないはず。
        ...(complexity !== undefined ? { complexity } : {}),
        ...(random() < 0.3 ? { models: [{ stage: 'implement', model: 'model-a' }] } : {}),
        ...(random() < 0.2 ? { manualSessionId: `session-${index}` } : {}),
      }),
    );
  }
  return tickets;
}

function generateReclaimRuns(seed: number, tickets: readonly Ticket[], count: number): ReclaimRunRecord[] {
  const random = createRandom(seed);
  const runs: ReclaimRunRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const projectId = pick(random, PROJECT_IDS);
    const candidates = tickets.filter((ticket) => ticket.projectId === projectId);
    const ticketIds: TicketId[] = [];
    const idCount = Math.floor(random() * 5);
    for (let n = 0; n < idCount; n += 1) {
      const chosen = candidates.length > 0 ? pick(random, candidates).id : 'bdboard-none';
      ticketIds.push(chosen);
      if (random() < 0.3) {
        ticketIds.push(chosen); // 同じ ID が同じ発火に複数回現れる
      }
    }
    if (random() < 0.3) {
      ticketIds.push('bdboard-unknown'); // 板面に無い ID
    }
    runs.push({
      projectId: random() < 0.1 ? 'proj-unlisted' : projectId,
      at: atMs(pick(random, BOUNDARY_TIMES)),
      reclaimedCount: random() < 0.25 ? null : Math.floor(random() * 4),
      ticketIds,
    });
  }
  return runs;
}

function generateLeftovers(seed: number, tickets: readonly Ticket[]): LeftoverCandidate[] {
  const random = createRandom(seed);
  const candidates: LeftoverCandidate[] = [];
  for (const ticket of tickets) {
    if (random() < 0.4) {
      candidates.push({
        projectId: random() < 0.1 ? 'proj-unlisted' : ticket.projectId,
        repoRootPath: `/repos/${ticket.projectId}`,
        ticketId: ticket.id,
        worktreePath: random() < 0.5 ? `/repos/${ticket.projectId}/.claude/worktrees/${ticket.id}` : null,
        branchName: random() < 0.5 ? `bd/${ticket.id}` : null,
      });
    }
  }
  return candidates;
}

function atRun(
  offsetMs: number,
  projectId: string,
  ticketIds: readonly TicketId[],
  reclaimedCount: number | null = 1,
): ReclaimRunRecord {
  return { projectId, at: atMs(START + offsetMs), reclaimedCount, ticketIds };
}

/** 再 claim 窓の境界 (delta = 0 / 1 / windowMs / windowMs+1 / 負) を 1 チケットずつ突く。 */
function windowBoundaryFixture(): ComputeHarnessKpiInput {
  const runAt = START + 5 * 24 * 60 * MINUTE_MS;
  const offsets: readonly [string, number][] = [
    ['t-neg', -1],
    ['t-zero', 0],
    ['t-one', 1],
    ['t-window-minus-one', RECLAIM_RECLAIM_WINDOW_MS - 1],
    ['t-window', RECLAIM_RECLAIM_WINDOW_MS],
    ['t-window-plus-one', RECLAIM_RECLAIM_WINDOW_MS + 1],
  ];
  const tickets = [
    ...offsets.map(([id, delta]) =>
      makeTicket({
        id,
        projectId: 'proj-a',
        status: 'in_progress',
        startedAt: atMs(runAt + delta),
        createdAt: atMs(START + 1),
      }),
    ),
    makeTicket({ id: 't-no-start', projectId: 'proj-a', status: 'open', createdAt: atMs(START + 1) }),
    makeTicket({ id: 't-open-live', projectId: 'proj-a', status: 'open', createdAt: atMs(START + 1) }),
    makeTicket({ id: 't-open-live', projectId: 'proj-b', status: 'open', createdAt: atMs(START + 1) }),
    makeTicket({ id: 't-inprog-live', projectId: 'proj-a', status: 'in_progress', createdAt: atMs(START + 1) }),
  ];
  const ids = [...offsets.map(([id]) => id), 't-no-start', 't-open-live', 't-inprog-live', 't-ghost'];
  return {
    tickets,
    range: RANGE,
    reclaimRuns: [
      { projectId: 'proj-a', at: atMs(runAt), reclaimedCount: 3, ticketIds: ids },
      // 期間の両端ちょうどと、その外側 1ms
      atRun(0, 'proj-a', ['t-open-live'], null),
      atRun(END - START, 'proj-b', ['t-open-live']),
      atRun(-1, 'proj-a', ['t-open-live']),
      atRun(END - START + 1, 'proj-a', ['t-open-live']),
    ],
    leftoverCandidates: [
      { projectId: 'proj-a', repoRootPath: '/r', ticketId: 't-open-live', worktreePath: '/w', branchName: null },
      { projectId: 'proj-b', repoRootPath: '/r', ticketId: 't-open-live', worktreePath: null, branchName: 'bd/t-open-live' },
      { projectId: 'proj-a', repoRootPath: '/r', ticketId: 't-inprog-live', worktreePath: '/w2', branchName: 'bd/x' },
      { projectId: 'proj-a', repoRootPath: '/r', ticketId: 't-no-start', worktreePath: null, branchName: null },
    ],
  };
}

function generatedFixture(seed: number): ComputeHarnessKpiInput {
  const tickets = generateTickets(seed, 600);
  return {
    tickets,
    range: RANGE,
    reclaimRuns: generateReclaimRuns(seed + 1, tickets, 60),
    leftoverCandidates: generateLeftovers(seed + 2, tickets),
  };
}

const FIXTURES: readonly (readonly [string, ComputeHarnessKpiInput])[] = [
  ['no tickets, no reclaim runs', { tickets: [], range: RANGE }],
  [
    'one in-range open human ticket',
    { tickets: [makeTicket({ labels: ['human'], createdAt: atMs(START + 1) })], range: RANGE },
  ],
  [
    'one out-of-range ticket',
    { tickets: [makeTicket({ labels: ['harness'], title: '重複', createdAt: atMs(START - 1) })], range: RANGE },
  ],
  [
    'a closed gate and a closed work ticket exactly on the range edges',
    {
      tickets: [
        makeTicket({ id: 'bdboard-g', issueType: 'gate', createdAt: atMs(START - 5), closedAt: atMs(START) }),
        makeTicket({ id: 'bdboard-w', labels: ['human'], createdAt: atMs(END - 5), closedAt: atMs(END) }),
        makeTicket({ id: 'bdboard-late', labels: ['human'], createdAt: atMs(END), closedAt: atMs(END + 1) }),
        // close が作成より前 (時計のずれ): 滞留 0 に切り上げる。中央値に響くよう 2 件置く
        // (切り上げが無いと負の値が中央値を引き下げる)。
        makeTicket({ id: 'bdboard-skew', labels: ['human'], createdAt: atMs(END - 1), closedAt: atMs(START + 2) }),
        makeTicket({ id: 'bdboard-skew2', labels: ['human'], createdAt: atMs(END - 1), closedAt: atMs(START + 3) }),
      ],
      range: RANGE,
    },
  ],
  [
    'same (projectId, id) twice: the later ticket wins in the reclaim lookup',
    {
      tickets: [
        makeTicket({ id: 'bdboard-dup', projectId: 'proj-a', status: 'open', createdAt: atMs(START + 1) }),
        makeTicket({
          id: 'bdboard-dup',
          projectId: 'proj-a',
          status: 'in_progress',
          startedAt: atMs(START + 10 * MINUTE_MS + 1),
          createdAt: atMs(START + 1),
        }),
      ],
      range: RANGE,
      reclaimRuns: [atRun(10 * MINUTE_MS, 'proj-a', ['bdboard-dup'])],
      leftoverCandidates: [
        { projectId: 'proj-a', repoRootPath: '/r', ticketId: 'bdboard-dup', worktreePath: '/w', branchName: null },
      ],
    },
  ],
  ['re-claim window boundaries and the open gate on live worktrees', windowBoundaryFixture()],
  [
    'a custom reclaim window',
    { ...windowBoundaryFixture(), reclaimWindowMs: 60 * MINUTE_MS },
  ],
  ['generated mix (seed 1)', generatedFixture(1)],
  ['generated mix (seed 20260930)', generatedFixture(20260930)],
  ['generated mix (seed 987654321)', generatedFixture(987654321)],
];

// --- tests ----------------------------------------------------------------------

describe('createHarnessKpiAccumulator vs the pre-kuui four-pass computeHarnessKpi (bdboard-kuui)', () => {
  it.each(FIXTURES)('computeHarnessKpi matches the reference: %s', (_name, input) => {
    expect(computeHarnessKpi(input)).toEqual(referenceComputeHarnessKpi(input));
  });

  it.each(FIXTURES)('add() one ticket at a time then finish() matches the reference: %s', (_name, input) => {
    const { tickets, ...rest } = input;
    const accumulator = createHarnessKpiAccumulator(rest);
    for (const ticket of tickets) {
      accumulator.add(ticket);
    }
    expect(accumulator.finish()).toEqual(referenceComputeHarnessKpi(input));
  });

  it('is not vacuous: the generated fixtures exercise every KPI branch', () => {
    for (const seed of [1, 20260930, 987654321]) {
      const kpi = referenceComputeHarnessKpi(generatedFixture(seed));
      expect(kpi.pendingDecisionDwell.closedGateCount).toBeGreaterThan(0);
      expect(kpi.pendingDecisionDwell.closedWorkCount).toBeGreaterThan(0);
      expect(kpi.pendingDecisionDwell.openGateCount).toBeGreaterThan(0);
      expect(kpi.pendingDecisionDwell.openWorkCount).toBeGreaterThan(0);
      expect(kpi.pendingDecisionDwell.medianMs).not.toBeNull();
      expect(kpi.harnessLabeled.matchedCount).toBeGreaterThan(0);
      expect(kpi.duplicateMention.matchedCount).toBeGreaterThan(0);
      expect(kpi.reclaim.runCount).toBeGreaterThan(0);
      expect(kpi.reclaim.unknownCountRunCount).toBeGreaterThan(0);
      expect(kpi.reclaim.identifiedTicketCount).toBeGreaterThan(0);
      expect(kpi.reclaim.reclaimedLiveWorktreeCount).toBeGreaterThan(0);
      expect(kpi.reclaim.reclaimedThenInProgressCount).toBeGreaterThan(0);
    }
  });

  it('is not vacuous: the window-boundary fixture counts exactly the in-window re-claims', () => {
    const { reclaim } = referenceComputeHarnessKpi(windowBoundaryFixture());
    // t-one / t-window-minus-one / t-window だけが delta ∈ (0, windowMs]
    expect(reclaim.reclaimedThenInProgressCount).toBe(3);
    // 「open かつ生存証拠あり」は t-open-live の 3 回: proj-a の worktree ありを期間内の
    // 2 発火 (main と start ちょうど)、proj-b のブランチありを end ちょうどの発火で。
    // t-inprog-live (in_progress) と t-no-start (証拠なし) は数えない。
    expect(reclaim.reclaimedLiveWorktreeCount).toBe(3);
    expect(reclaim.runCount).toBe(3);
  });

  it('returns the same result when finish() is called twice', () => {
    const { tickets, ...rest } = generatedFixture(1);
    const accumulator = createHarnessKpiAccumulator(rest);
    for (const ticket of tickets) {
      accumulator.add(ticket);
    }
    const first = accumulator.finish();
    expect(accumulator.finish()).toEqual(first);
  });

  it('keeps two accumulators independent when their add() batches are interleaved', () => {
    const input = generatedFixture(20260930);
    const { tickets, ...rest } = input;
    const first = createHarnessKpiAccumulator(rest);
    const second = createHarnessKpiAccumulator(rest);
    // 同じ入力を 2 つの集計器へ、バッチごとに交互に流す。状態を共有していれば
    // (モジュールレベルの変数・共有配列など) どちらかの結果が食い違う。
    const third = Math.floor(tickets.length / 3);
    const batches = [
      tickets.slice(0, third),
      tickets.slice(third, 2 * third),
      tickets.slice(2 * third),
    ];
    for (const batch of batches) {
      for (const ticket of batch) {
        first.add(ticket);
      }
      for (const ticket of batch) {
        second.add(ticket);
      }
    }
    const expected = referenceComputeHarnessKpi(input);
    expect(first.finish()).toEqual(expected);
    expect(second.finish()).toEqual(expected);
  });

  it('is unaffected by the caller mutating reclaimRuns / leftoverCandidates after creation', () => {
    // application 層は add の間に await で制御を返す。その間に reclaim-history など
    // 呼び出し側の配列が伸びても、集計中の結果が途中から食い違わないこと。
    const input = windowBoundaryFixture();
    const reclaimRuns = [...(input.reclaimRuns ?? [])];
    const leftoverCandidates = [...(input.leftoverCandidates ?? [])];
    const expected = referenceComputeHarnessKpi({ ...input, reclaimRuns, leftoverCandidates });

    const { tickets, ...rest } = input;
    const accumulator = createHarnessKpiAccumulator({ ...rest, reclaimRuns, leftoverCandidates });
    reclaimRuns.push(atRun(1000, 'proj-a', ['t-one'], null));
    leftoverCandidates.push({
      projectId: 'proj-a',
      repoRootPath: '/r',
      ticketId: 't-no-start',
      worktreePath: '/late',
      branchName: null,
    });
    for (const ticket of tickets) {
      accumulator.add(ticket);
    }
    expect(accumulator.finish()).toEqual(expected);
  });
});
