import { describe, expect, it } from 'vitest';
import { checkHygiene } from './hygiene.js';
import { NOW } from './hygiene-test-support.js';
import type { LeftoverCandidate } from './git-worktree.js';
import { makeTicket } from './test-support.js';

describe('checkHygiene reclaimed_live_worktree', () => {
  const repoRoot = '/projects/bdboard';
  const worktreePath = `${repoRoot}/.claude/worktrees/bdboard-live`;
  const branchName = 'bd/bdboard-live';

  function liveCandidate(overrides: Partial<LeftoverCandidate> = {}): LeftoverCandidate {
    return {
      projectId: repoRoot,
      repoRootPath: repoRoot,
      ticketId: 'bdboard-live',
      worktreePath,
      branchName,
      ...overrides,
    };
  }

  // 2026-09-05 の実事象の再現 (bdboard-okdh / 53my / s0o7 / s1vj)。
  // 生存セッションのチケットが reclaim で open へ戻され、worktree だけが残った盤面。
  it('flags open tickets that still have a worktree and branch', () => {
    const ticket = makeTicket({ id: 'bdboard-live', projectId: repoRoot, status: 'open' });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate()],
    });

    const found = issues.filter((issue) => issue.kind === 'reclaimed_live_worktree');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'reclaimed_live_worktree',
      ticketId: 'bdboard-live',
      projectId: repoRoot,
      severity: 'warning',
    });
    // 文言そのものを固定する。`toContain` だけだと evidence の組み立て
    // ('worktree とブランチ' / 'worktree' / 'ブランチ') を書き換えても落ちない。
    expect(found[0]?.message).toBe(
      'チケットは open ですが worktree とブランチが残っています。' +
        '作業中に自動 reclaim された可能性があります。' +
        'bd ready が空きとして提示するので、作業が生きているなら ' +
        'bd update bdboard-live --claim で claim し直してください' +
        '（確認: bd history bdboard-live --events の直近の状態変更が lease_reclaimed なら自動回収です）',
    );
  });

  // KIND_ORDER の**相対順**を固定する。Record 化で「kind の足し忘れ」は tsc が
  // 落とすようになったが、値を入れ替えても型は通るので順序はテストで押さえる。
  it('sorts between merged_leftover and orphan_heartbeat_loop', () => {
    const open = makeTicket({ id: 'bdboard-live', projectId: repoRoot, status: 'open' });
    const closed = makeTicket({ id: 'bdboard-done', projectId: repoRoot, status: 'closed' });

    const issues = checkHygiene([open, closed], {
      now: NOW,
      leftoverCandidates: [
        liveCandidate(),
        liveCandidate({ ticketId: 'bdboard-done' }),
      ],
      heartbeatLoops: [
        {
          pid: 12_345,
          commandLine:
            'bash /path/bd-heartbeat.sh start --session-pid 4242 --interval 90 ' +
            '--max-hours 12 --repo /repo bdboard-done',
        },
      ],
    });

    // 前後を両方挟む。片側だけだと隣の kind と値を入れ替えても通ってしまう。
    const kinds = issues
      .map((issue) => issue.kind)
      .filter(
        (kind) =>
          kind === 'merged_leftover' ||
          kind === 'reclaimed_live_worktree' ||
          kind === 'orphan_heartbeat_loop',
      );
    expect(kinds).toEqual([
      'merged_leftover',
      'reclaimed_live_worktree',
      'orphan_heartbeat_loop',
    ]);
  });

  // 生きているかもしれない作業に削除コマンドを添えてはいけない (本文のコメント参照)。
  // cleanup を足すと UI が lsof ガード付きの `git worktree remove` を提案してしまう。
  it('never attaches a cleanup script, because the work may still be alive', () => {
    const ticket = makeTicket({ id: 'bdboard-live', projectId: repoRoot, status: 'open' });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate()],
    });

    const found = issues.find((issue) => issue.kind === 'reclaimed_live_worktree');
    expect(found).toBeDefined();
    expect(found?.cleanup).toBeUndefined();
  });

  it('reports which of worktree / branch survives', () => {
    const ticket = makeTicket({ id: 'bdboard-live', projectId: repoRoot, status: 'open' });

    const worktreeOnly = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate({ branchName: null })],
    }).find((issue) => issue.kind === 'reclaimed_live_worktree');
    expect(worktreeOnly?.message).toContain('チケットは open ですが worktree が残っています');

    const branchOnly = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate({ worktreePath: null })],
    }).find((issue) => issue.kind === 'reclaimed_live_worktree');
    expect(branchOnly?.message).toContain('チケットは open ですがブランチが残っています');
  });

  it('does not flag in_progress tickets (lease is alive, or stale_in_progress covers it)', () => {
    const ticket = makeTicket({
      id: 'bdboard-live',
      projectId: repoRoot,
      status: 'in_progress',
      startedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate()],
    });

    expect(issues.filter((issue) => issue.kind === 'reclaimed_live_worktree')).toEqual([]);
  });

  it('does not flag closed tickets (merged_leftover owns that side)', () => {
    const ticket = makeTicket({
      id: 'bdboard-live',
      projectId: repoRoot,
      status: 'closed',
      closedAt: NOW,
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate()],
    });

    expect(issues.filter((issue) => issue.kind === 'reclaimed_live_worktree')).toEqual([]);
    expect(issues.filter((issue) => issue.kind === 'merged_leftover')).toHaveLength(1);
  });

  it('does not flag when neither worktree nor branch exists', () => {
    const ticket = makeTicket({ id: 'bdboard-live', projectId: repoRoot, status: 'open' });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate({ worktreePath: null, branchName: null })],
    });

    expect(issues.filter((issue) => issue.kind === 'reclaimed_live_worktree')).toEqual([]);
  });

  it('does not flag when the candidate belongs to a different project', () => {
    const ticket = makeTicket({ id: 'bdboard-live', projectId: '/projects/other', status: 'open' });

    const issues = checkHygiene([ticket], {
      now: NOW,
      leftoverCandidates: [liveCandidate()],
    });

    expect(issues.filter((issue) => issue.kind === 'reclaimed_live_worktree')).toEqual([]);
  });
});
