import { describe, expect, it } from 'vitest';
import {
  checkHygiene,
  STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND,
  type HarnessWorktreeLag,
} from './hygiene.js';
import { makeTicket } from './test-support.js';

describe('checkHygiene stale_harness_worktree', () => {
  const repoRoot = '/repo';
  const NOW = new Date('2026-09-05T12:00:00Z');

  function lag(overrides: Partial<HarnessWorktreeLag> = {}): HarnessWorktreeLag {
    return {
      projectId: repoRoot,
      ticketId: 'bdboard-frozen',
      worktreePath: '/repo/.claude/worktrees/bdboard-frozen',
      commitsBehind: 17,
      baseRef: 'origin/main',
      hasCommonAncestor: true,
      ...overrides,
    };
  }

  // 2026-09-05 実測: ハーネス差分 17 コミットの worktree で稼働していたセッションが、
  // 同じ日にハーネス改善 PR を自分でマージしていた。
  it('flags an in_progress ticket whose harness lags behind main', () => {
    const ticket = makeTicket({
      id: 'bdboard-frozen',
      projectId: repoRoot,
      status: 'in_progress',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      harnessWorktreeLags: [lag()],
    });

    const found = issues.filter((issue) => issue.kind === 'stale_harness_worktree');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ticketId: 'bdboard-frozen',
      projectId: repoRoot,
      severity: 'warning',
    });
    expect(found[0]?.message).toBe(
      'この worktree のハーネスは origin/main より 17 コミットぶん古いままです。' +
        'ハーネス (.claude/skills と .claude/settings.json) はチェックアウト単位なので、' +
        'このセッションは worktree 作成時点の古い規律・hooks のまま動いています。' +
        'git -C /repo/.claude/worktrees/bdboard-frozen rebase origin/main で追従してください',
    );
  });

  // rebase は掃除ではないし、未コミットの成果を抱えた worktree にワンクリック相当の
  // コマンドを出すのは危険。
  it('never attaches a cleanup script', () => {
    const ticket = makeTicket({
      id: 'bdboard-frozen',
      projectId: repoRoot,
      status: 'in_progress',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      harnessWorktreeLags: [lag()],
    });

    const found = issues.find((issue) => issue.kind === 'stale_harness_worktree');
    expect(found).toBeDefined();
    expect(found?.cleanup).toBeUndefined();
  });

  it('uses the measured origin/master ref in the warning and rebase guidance', () => {
    const ticket = makeTicket({
      id: 'bdboard-frozen',
      projectId: repoRoot,
      status: 'in_progress',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      harnessWorktreeLags: [lag({ baseRef: 'origin/master' })],
    });

    expect(issues.find((issue) => issue.kind === 'stale_harness_worktree')?.message).toContain(
      'origin/master より 17 コミットぶん古いままです。',
    );
    expect(issues.find((issue) => issue.kind === 'stale_harness_worktree')?.message).toContain(
      'rebase origin/master で追従してください',
    );
  });

  it('tells the reader to sort it out by hand instead of rebasing when there is no common ancestor (bdboard-0chq)', () => {
    const ticket = makeTicket({
      id: 'bdboard-frozen',
      projectId: repoRoot,
      status: 'in_progress',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      harnessWorktreeLags: [lag({ hasCommonAncestor: false })],
    });

    const found = issues.filter((issue) => issue.kind === 'stale_harness_worktree');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('共通の祖先がありません');
    expect(found[0]?.message).toContain('手で整理してください');
    expect(found[0]?.message).not.toMatch(/rebase origin\/main/);
  });

  it('stays quiet just below the threshold and fires just above it', () => {
    const ticket = makeTicket({
      id: 'bdboard-frozen',
      projectId: repoRoot,
      status: 'in_progress',
    });

    const below = checkHygiene([ticket], {
      now: NOW,
      harnessWorktreeLags: [
        lag({ commitsBehind: STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND - 1 }),
      ],
    });
    expect(below.some((issue) => issue.kind === 'stale_harness_worktree')).toBe(false);

    const atThreshold = checkHygiene([ticket], {
      now: NOW,
      harnessWorktreeLags: [
        lag({ commitsBehind: STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND }),
      ],
    });
    expect(atThreshold.some((issue) => issue.kind === 'stale_harness_worktree')).toBe(true);
  });

  // 誰も作業していない worktree が古いのは当たり前で、それは merged_leftover /
  // reclaimed_live_worktree の担当。
  it('ignores tickets that are not in_progress', () => {
    for (const status of ['open', 'closed'] as const) {
      const ticket = makeTicket({ id: 'bdboard-frozen', projectId: repoRoot, status });

      const issues = checkHygiene([ticket], {
        now: NOW,
        harnessWorktreeLags: [lag()],
      });

      expect(issues.some((issue) => issue.kind === 'stale_harness_worktree')).toBe(false);
    }
  });

  it('ignores a lag whose ticket belongs to a different project', () => {
    const ticket = makeTicket({
      id: 'bdboard-frozen',
      projectId: '/other',
      status: 'in_progress',
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      harnessWorktreeLags: [lag()],
    });

    expect(issues.some((issue) => issue.kind === 'stale_harness_worktree')).toBe(false);
  });

  it('emits nothing when no lags are supplied at all', () => {
    const ticket = makeTicket({
      id: 'bdboard-frozen',
      projectId: repoRoot,
      status: 'in_progress',
    });

    const issues = checkHygiene([ticket], { now: NOW });

    expect(issues.some((issue) => issue.kind === 'stale_harness_worktree')).toBe(false);
  });

  it('sorts between reclaimed_live_worktree and orphan_heartbeat_loop', () => {
    const frozen = makeTicket({
      id: 'bdboard-frozen',
      projectId: repoRoot,
      status: 'in_progress',
    });
    const open = makeTicket({ id: 'bdboard-live', projectId: repoRoot, status: 'open' });
    const closed = makeTicket({ id: 'bdboard-done', projectId: repoRoot, status: 'closed' });

    const issues = checkHygiene([frozen, open, closed], {
      now: NOW,
      leftoverCandidates: [
        {
          projectId: repoRoot,
          repoRootPath: repoRoot,
          ticketId: 'bdboard-live',
          worktreePath: '/repo/.claude/worktrees/bdboard-live',
          branchName: 'bd/bdboard-live',
        },
      ],
      harnessWorktreeLags: [lag()],
      heartbeatLoops: [
        {
          pid: 12_345,
          commandLine:
            'bash /path/bd-heartbeat.sh start --session-pid 4242 --interval 90 ' +
            '--max-hours 12 --repo /repo bdboard-done',
        },
      ],
    });

    const kinds = issues
      .map((issue) => issue.kind)
      .filter(
        (kind) =>
          kind === 'reclaimed_live_worktree' ||
          kind === 'stale_harness_worktree' ||
          kind === 'orphan_heartbeat_loop',
      );
    expect(kinds).toEqual([
      'reclaimed_live_worktree',
      'stale_harness_worktree',
      'orphan_heartbeat_loop',
    ]);
  });
});
