import { describe, expect, it, vi } from 'vitest';
import type { GitWorktreeSnapshot } from '../../domain/git-worktree.js';
import type { Project } from '../../domain/project.js';
import type { ReclaimPlan } from '../../domain/reclaim-plan.js';
import type { InProgressWithLease, LeaseReader } from '../ports/lease-reader.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { planProjectReclaim } from './plan-project-reclaim.js';
import type { ReclaimPlanOutcome } from './reclaim-scheduler.js';

const NOW = new Date('2026-09-05T12:00:00Z');

const project: Project = {
  id: '/repo',
  name: 'repo',
  rootPath: '/repo',
  aliasPaths: [],
  prefixes: ['bdboard'],
};

function scannerWith(snapshot: GitWorktreeSnapshot): WorktreeScanner {
  return {
    scan: async () => snapshot,
    listChangedFiles: async () => [],
  };
}

const emptySnapshot: GitWorktreeSnapshot = { worktrees: [], bdBranches: [], complete: true };

function snapshotWithBranch(ticketId: string): GitWorktreeSnapshot {
  return { worktrees: [], bdBranches: [`bd/${ticketId}`], complete: true };
}

function leaseTicket(overrides: Partial<InProgressWithLease> = {}): InProgressWithLease {
  return {
    id: 'bdboard-a',
    leaseExpiresAt: null,
    heartbeatAt: null,
    startedAt: null,
    createdAt: '2026-09-05T00:00:00Z',
    ...overrides,
  };
}

function leaseReaderWith(items: readonly InProgressWithLease[]): LeaseReader {
  return { listInProgressWithLease: async () => items };
}

function leaseReaderThatFails(error: unknown): LeaseReader {
  return {
    listInProgressWithLease: async () => {
      throw error;
    },
  };
}

/** 計画が立った結果だけを取り出す。見送りだったらテストを落とす。 */
function planOf(outcome: ReclaimPlanOutcome): ReclaimPlan {
  if (outcome.kind !== 'plan') {
    throw new Error(`expected a plan, got skipped: ${outcome.reason}`);
  }
  return outcome.plan;
}

describe('planProjectReclaim', () => {
  // 要点: LeaseReader が失敗しても、盤面キャッシュの古い集合へフォールバックしては
  // ならない。フォールバックすると「refresh-projects が失敗し続ける間、reclaim は
  // キャッシュが最後に成功した時点の集合にしか効かない」準停止状態に戻る (bdboard-vz01)。
  it('skips with lease-read-failed when the LeaseReader fails, without falling back to a stale set', async () => {
    const logWarn = vi.fn();
    const scan = vi.fn(async () => emptySnapshot);

    const outcome = await planProjectReclaim(project, {
      leaseReader: leaseReaderThatFails(new Error('bd list failed')),
      scanner: { scan, listChangedFiles: async () => [] },
      now: () => NOW,
      logWarn,
    });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'lease-read-failed' });
    expect(logWarn).toHaveBeenCalledOnce();
    // git を叩く必要すらない — in_progress 集合が分からない時点で見送る。
    expect(scan).not.toHaveBeenCalled();
  });

  // 本番のスキャナは git の非ゼロ / timeout / spawn 失敗を **throw せず空スナップショットに
  // 畳む**。complete を見ないと、負荷で git が 10 秒に間に合わなかっただけの巡回が
  // 「worktree が 1 つも無い」= 全件回収対象、に化ける (fable レビュー B1)。
  it('skips with scan-incomplete when the scan came back incomplete', async () => {
    const logWarn = vi.fn();

    const outcome = await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([leaseTicket({ id: 'bdboard-a' })]),
      scanner: scannerWith({ worktrees: [], bdBranches: [], complete: false }),
      now: () => NOW,
      logWarn,
    });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'scan-incomplete' });
    expect(logWarn).toHaveBeenCalledOnce();
  });

  // **全件回収へのフォールバックを絶対に作らない**、が要点。git が読めない
  // 一時的な状態で「証拠なし = 回収してよい」に倒すと元の事故に戻る。
  it('skips with scan-failed when the worktree scan fails', async () => {
    const logWarn = vi.fn();
    const scanner: WorktreeScanner = {
      scan: async () => {
        throw new Error('not a git repository');
      },
      listChangedFiles: async () => [],
    };

    const outcome = await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([leaseTicket({ id: 'bdboard-a' })]),
      scanner,
      now: () => NOW,
      logWarn,
    });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'scan-failed' });
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('plans nothing when the project has no in_progress tickets', async () => {
    const scan = vi.fn(async () => emptySnapshot);

    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([]),
      scanner: { scan, listChangedFiles: async () => [] },
      now: () => NOW,
    }));

    expect(plan).toEqual({ reclaimTicketIds: [], protectedTicketIds: [] });
    // git を叩く必要すらない。
    expect(scan).not.toHaveBeenCalled();
  });

  it('protects an in_progress ticket whose bd branch still exists', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-live',
          leaseExpiresAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        }),
        leaseTicket({
          id: 'bdboard-dead',
          leaseExpiresAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        }),
      ]),
      scanner: scannerWith(snapshotWithBranch('bdboard-live')),
      now: () => NOW,
    }));

    expect(plan).toEqual({
      reclaimTicketIds: ['bdboard-dead'],
      protectedTicketIds: ['bdboard-live'],
    });
  });

  // acceptance (1): 保護窓の起点が lease 失効時刻になったことを固定する。
  // startedAt だけで測ると 20h 前の claim は 12h 上限を超えて即回収対象になるが、
  // heartbeat が生きていて lease がつい 30 分前にしか失効していないなら、
  // lease 失効起点で測った経過は 30 分 (<= 12h) なので保護されるべき。
  it('measures the protection cutoff from lease expiry, not from how long ago the ticket was claimed', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-long-running',
          // 20 時間前に claim された (従来ロジックなら 12h 上限超えで即回収)。
          startedAt: new Date(NOW.getTime() - 20 * 60 * 60_000).toISOString(),
          // だが lease は heartbeat で延長され続けており、失効したのはつい 30 分前。
          leaseExpiresAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
        }),
      ]),
      scanner: scannerWith(snapshotWithBranch('bdboard-long-running')),
      now: () => NOW,
    }));

    expect(plan.protectedTicketIds).toEqual(['bdboard-long-running']);
    expect(plan.reclaimTicketIds).toEqual([]);
  });

  // lease 失効起点で測ると、失効から 12h 経過した時点で証拠があっても回収対象へ戻る。
  it('keeps protecting while the lease has not expired yet (negative elapsed time)', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-live-lease',
          // lease はまだ 30 分先まで有効 — 経過が負値でも保護側に倒れること。
          // Math.max(0, elapsed) のような「負値の正規化」を入れるとここで落ちる。
          leaseExpiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
        }),
      ]),
      scanner: scannerWith(snapshotWithBranch('bdboard-live-lease')),
      now: () => NOW,
    }));

    expect(plan.protectedTicketIds).toEqual(['bdboard-live-lease']);
    expect(plan.reclaimTicketIds).toEqual([]);
  });

  it('reclaims once the cap has passed measured from lease expiry, even with worktree evidence', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-stale-lease',
          leaseExpiresAt: new Date(NOW.getTime() - 13 * 60 * 60_000).toISOString(),
        }),
      ]),
      scanner: scannerWith(snapshotWithBranch('bdboard-stale-lease')),
      now: () => NOW,
    }));

    expect(plan.reclaimTicketIds).toEqual(['bdboard-stale-lease']);
    expect(plan.protectedTicketIds).toEqual([]);
  });

  // acceptance (2): 盤面キャッシュに載っていない (= もはや参照すらしない) in_progress
  // チケットも、LeaseReader が返す限り計画の対象になる。plan-project-reclaim はもう
  // 盤面キャッシュを一切受け取らないので、これは構造的に保証される。
  it('includes in_progress tickets that the board cache would never have known about', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-not-in-cache',
          leaseExpiresAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        }),
      ]),
      // worktree/branch 証拠なし → 回収対象になるはず。
      scanner: scannerWith(emptySnapshot),
      now: () => NOW,
    }));

    expect(plan.reclaimTicketIds).toEqual(['bdboard-not-in-cache']);
  });

  it('falls back to startedAt when leaseExpiresAt is missing', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-live',
          leaseExpiresAt: null,
          startedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        }),
      ]),
      scanner: scannerWith(snapshotWithBranch('bdboard-live')),
      now: () => NOW,
    }));

    expect(plan.protectedTicketIds).toEqual(['bdboard-live']);
    expect(plan.reclaimTicketIds).toEqual([]);
  });

  it('falls back to createdAt when both leaseExpiresAt and startedAt are missing', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-live',
          leaseExpiresAt: null,
          startedAt: null,
          // 上限 (12h) の内側。フォールバックしても保護は効く。
          createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString(),
        }),
      ]),
      scanner: scannerWith(snapshotWithBranch('bdboard-live')),
      now: () => NOW,
    }));

    expect(plan.protectedTicketIds).toEqual(['bdboard-live']);
    expect(plan.reclaimTicketIds).toEqual([]);
  });

  it('reclaims once createdAt-based fallback exceeds the cap', async () => {
    const plan = planOf(await planProjectReclaim(project, {
      leaseReader: leaseReaderWith([
        leaseTicket({
          id: 'bdboard-a',
          leaseExpiresAt: null,
          startedAt: null,
          createdAt: new Date('2026-09-04T00:00:00Z').toISOString(), // 36 時間前
        }),
      ]),
      scanner: scannerWith(snapshotWithBranch('bdboard-a')),
      now: () => NOW,
      logWarn: () => {},
    }));

    expect(plan.reclaimTicketIds).toEqual(['bdboard-a']);
    expect(plan.protectedTicketIds).toEqual([]);
  });
});
