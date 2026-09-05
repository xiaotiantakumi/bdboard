import { describe, expect, it, vi } from 'vitest';
import type { GitWorktreeSnapshot } from '../../domain/git-worktree.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import type { WorktreeScanner } from '../ports/worktree-scanner.js';
import { planProjectReclaim } from './plan-project-reclaim.js';

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

const emptySnapshot: GitWorktreeSnapshot = { worktrees: [], bdBranches: [] };

function snapshotWithBranch(ticketId: string): GitWorktreeSnapshot {
  return { worktrees: [], bdBranches: [`bd/${ticketId}`] };
}

describe('planProjectReclaim', () => {
  it('returns null when the ticket list is unknown, so the caller skips the cycle', async () => {
    const logWarn = vi.fn();

    const plan = await planProjectReclaim(project, {
      listTickets: () => undefined,
      scanner: scannerWith(emptySnapshot),
      now: () => NOW,
      logWarn,
    });

    expect(plan).toBeNull();
    expect(logWarn).toHaveBeenCalledOnce();
  });

  // **全件回収へのフォールバックを絶対に作らない**、が要点。git が読めない
  // 一時的な状態で「証拠なし = 回収してよい」に倒すと元の事故に戻る。
  it('returns null when the worktree scan fails', async () => {
    const logWarn = vi.fn();
    const scanner: WorktreeScanner = {
      scan: async () => {
        throw new Error('not a git repository');
      },
      listChangedFiles: async () => [],
    };

    const plan = await planProjectReclaim(project, {
      listTickets: () => [makeTicket({ id: 'bdboard-a', status: 'in_progress' })],
      scanner,
      now: () => NOW,
      logWarn,
    });

    expect(plan).toBeNull();
    expect(logWarn).toHaveBeenCalledOnce();
  });

  it('plans nothing when the project has no in_progress tickets', async () => {
    const scan = vi.fn(async () => emptySnapshot);

    const plan = await planProjectReclaim(project, {
      listTickets: () => [makeTicket({ id: 'bdboard-a', status: 'open' })],
      scanner: { scan, listChangedFiles: async () => [] },
      now: () => NOW,
    });

    expect(plan).toEqual({ reclaimTicketIds: [], protectedTicketIds: [] });
    // git を叩く必要すらない。
    expect(scan).not.toHaveBeenCalled();
  });

  it('protects an in_progress ticket whose bd branch still exists', async () => {
    const plan = await planProjectReclaim(project, {
      listTickets: () => [
        makeTicket({
          id: 'bdboard-live',
          status: 'in_progress',
          startedAt: new Date(NOW.getTime() - 20 * 60_000),
        }),
        makeTicket({
          id: 'bdboard-dead',
          status: 'in_progress',
          startedAt: new Date(NOW.getTime() - 20 * 60_000),
        }),
      ],
      scanner: scannerWith(snapshotWithBranch('bdboard-live')),
      now: () => NOW,
    });

    expect(plan).toEqual({
      reclaimTicketIds: ['bdboard-dead'],
      protectedTicketIds: ['bdboard-live'],
    });
  });

  it('falls back to updatedAt when the ticket has no startedAt', async () => {
    const plan = await planProjectReclaim(project, {
      listTickets: () => [
        makeTicket({
          id: 'bdboard-live',
          status: 'in_progress',
          startedAt: undefined,
          // 上限を大きく超えた updatedAt。保護が切れる側に倒れることを固定する。
          updatedAt: new Date(NOW.getTime() - 48 * 60 * 60_000),
        }),
      ],
      scanner: scannerWith(snapshotWithBranch('bdboard-live')),
      now: () => NOW,
    });

    expect(plan?.reclaimTicketIds).toEqual(['bdboard-live']);
  });
});
