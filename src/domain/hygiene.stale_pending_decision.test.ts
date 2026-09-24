import { describe, expect, it } from 'vitest';
import { checkHygiene, pendingDecisionKey } from './hygiene.js';
import { blocksEdge, NOW } from './hygiene-test-support.js';
import { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';
import { makeTicket } from './test-support.js';
import type { Ticket } from './ticket.js';

describe('checkHygiene stale_pending_decision (bdboard-ijk1)', () => {
  const PENDING_MS = DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs;

  /** makeTicket の既定 projectId。 */
  const PROJECT = '/projects/bdboard';

  function keys(...ids: readonly string[]): Set<string> {
    return new Set(ids.map((id) => pendingDecisionKey(PROJECT, id)));
  }

  function pendingIssues(
    tickets: readonly Ticket[],
    pendingIds: readonly string[],
  ) {
    return checkHygiene(tickets, {
      now: NOW,
      pendingDecisionKeys: keys(...pendingIds),
    }).filter((issue) => issue.kind === 'stale_pending_decision');
  }

  it('flags a pending ticket that has not moved for the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - PENDING_MS),
    });

    const issues = pendingIssues([ticket], ['bdboard-waiting']);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toBe('確認待ちのまま 3 日以上動きがありません');
    expect(issues[0]?.severity).toBe('warning');
  });

  it('stays quiet one millisecond before the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - PENDING_MS + 1),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])).toEqual([]);
  });

  it('reports the elapsed days rather than the threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 16 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])[0]?.message).toBe(
      '確認待ちのまま 16 日以上動きがありません',
    );
  });

  it('ignores tickets that are not awaiting a human decision', () => {
    // 同じだけ放置されていても、human ラベルが無ければ確認待ちではない。
    const ticket = makeTicket({
      id: 'bdboard-quiet',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], [])).toEqual([]);
  });

  it('emits nothing when the caller passes no pending set at all', () => {
    // ドメインは Ticket からは確認待ちを判定できない。呼び出し側が集めて渡さない
    // 限り、この検知は黙っていなければならない (誤検知の方が害が大きい)。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    expect(
      checkHygiene([ticket], { now: NOW }).map((issue) => issue.kind),
    ).not.toContain('stale_pending_decision');
  });

  it('ignores closed tickets that still carry the human label', () => {
    // deriveLane も closed を done で上書きする (ラベル外し忘れの保険)。盤面で
    // done のカードを健全性だけが「確認待ちが放置」と言うのは矛盾になる。
    const ticket = makeTicket({
      id: 'bdboard-done',
      status: 'closed',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], ['bdboard-done'])).toEqual([]);
  });

  it('honours a custom threshold', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
    });

    expect(
      checkHygiene([ticket], {
        now: NOW,
        pendingDecisionKeys: keys('bdboard-waiting'),
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          stalePendingDecisionAfterMs: 5 * 24 * 60 * 60_000,
        },
      }),
    ).toEqual([]);

    expect(
      checkHygiene([ticket], {
        now: NOW,
        pendingDecisionKeys: keys('bdboard-waiting'),
        thresholds: {
          ...DEFAULT_HYGIENE_THRESHOLDS,
          stalePendingDecisionAfterMs: 24 * 60 * 60_000,
        },
      }).map((issue) => issue.kind),
    ).toEqual(['stale_pending_decision']);
  });

  it('defaults to three days', () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs).toBe(
      3 * 24 * 60 * 60_000,
    );
  });

  it('sorts after unblocked_high_priority_idle and before merged_leftover', () => {
    // KIND_ORDER に足し忘れると tsc が落ちる (Record 化した。bdboard-rkde)。
    // 値の入れ替えは型では捕まらないので、並び順はこの手のテストで固定する。
    const idle = makeTicket({
      id: 'bdboard-idle',
      status: 'open',
      priority: 0,
      dependencies: [blocksEdge('bdboard-idle', 'bdboard-donedep')],
    });
    const doneDep = makeTicket({ id: 'bdboard-donedep', status: 'closed' });
    const waiting = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - PENDING_MS),
    });

    const kinds = checkHygiene([idle, doneDep, waiting], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
    })
      .map((issue) => issue.kind)
      .filter(
        (kind) =>
          kind === 'unblocked_high_priority_idle' ||
          kind === 'stale_pending_decision',
      );

    expect(kinds).toEqual([
      'unblocked_high_priority_idle',
      'stale_pending_decision',
    ]);
  });

  it('floors a fractional elapsed span instead of rounding it up', () => {
    // 文言が「N 日以上」なので、切り上げ/四捨五入だと嘘になる (3.5日で「4日以上」)。
    // 既存のテストが 3.000日 / 16.000日 ちょうどしか見ていないと、
    // Math.floor -> Math.ceil の変異が生き残る (fable レビュー指摘)。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 3.5 * 24 * 60 * 60_000),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])[0]?.message).toBe(
      '確認待ちのまま 3 日以上動きがありません',
    );
  });

  it('stays quiet when updatedAt is not a usable date', () => {
    // 壊れた日付でガードを外すと NaN < threshold が false になって検知側へ抜け、
    // 「確認待ちのまま NaN 日以上動きがありません」を出してしまう。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date('not a date'),
    });

    expect(pendingIssues([ticket], ['bdboard-waiting'])).toEqual([]);
  });

  it('does not borrow another project\'s pending decision for the same id', () => {
    // bd のIDはプロジェクト内でしか一意でない。盤面は
    // humanLabeledIdsFromCache を entry ごとに作る (get-board.ts) ので、
    // 確認待ち判定は常にプロジェクト内で閉じている。ここが projectId を見ないと、
    // 2プロジェクトが同時にスコープへ入った瞬間、盤面では通常レーンのカードに
    // 「確認待ちが放置されている」が付く。
    const stale = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
    const inA = makeTicket({
      id: 'bdboard-dup',
      projectId: '/projects/a',
      status: 'open',
      updatedAt: stale,
    });
    const inB = makeTicket({
      id: 'bdboard-dup',
      projectId: '/projects/b',
      status: 'open',
      updatedAt: stale,
    });

    const issues = checkHygiene([inA, inB], {
      now: NOW,
      pendingDecisionKeys: new Set([
        pendingDecisionKey('/projects/a', 'bdboard-dup'),
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues.map((issue) => issue.projectId)).toEqual(['/projects/a']);
  });

  it('replaces stale_in_progress rather than doubling up on it', () => {
    // deriveLane は human ラベルを in_progress より優先する
    // (src/domain/readiness.ts)。盤面が確認待ちに置いているカードに対して
    // 「長期 in_progress」も出すと、盤面に無いレーンの話をしたうえで
    // 同じ放置を2行叱ることになる。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'in_progress',
      startedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const kinds = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
    }).map((issue) => issue.kind);

    expect(kinds).toContain('stale_pending_decision');
    expect(kinds).not.toContain('stale_in_progress');
  });

  it('uses the last comment instead of updatedAt when the comment is newer', () => {
    // bd の updated_at はコメントで動かない (bdboard-19db)。updatedAt だけを見ると、
    // コメントで議論が続いているチケットまで「放置」として出る。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date(NOW.getTime() - 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues).toEqual([]);
  });

  it('keeps flagging when the last comment is itself old enough', () => {
    // コメントを見るようにしたせいで検知が死んでいないことの確認。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date(NOW.getTime() - 5 * 24 * 60 * 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    // 日数はコメント側から数える。30日ではなく5日。
    expect(issues[0]?.message).toBe('確認待ちのまま 5 日以上動きがありません');
  });

  it('keeps updatedAt when it is the newer of the two', () => {
    // コメントのほうが古いのは普通にある (コメント後に優先度を変えた等)。
    // 決め打ちで置き換えると、逆に検知が早まる方向の誤りになる。
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 4 * 24 * 60 * 60_000),
    });

    const issues = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date(NOW.getTime() - 20 * 24 * 60 * 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues[0]?.message).toBe('確認待ちのまま 4 日以上動きがありません');
  });

  it('falls back to updatedAt when the anchor is unusable or missing', () => {
    const ticket = makeTicket({
      id: 'bdboard-waiting',
      status: 'open',
      updatedAt: new Date(NOW.getTime() - 9 * 24 * 60 * 60_000),
    });

    const withBadAnchor = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-waiting'),
      pendingCommentAnchors: new Map([
        [pendingDecisionKey(PROJECT, 'bdboard-waiting'), new Date('not a date')],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(withBadAnchor[0]?.message).toBe('確認待ちのまま 9 日以上動きがありません');
    expect(pendingIssues([ticket], ['bdboard-waiting'])[0]?.message).toBe(
      '確認待ちのまま 9 日以上動きがありません',
    );
  });

  it('does not let one project\'s comment anchor reach another project\'s ticket', () => {
    const stale = new Date(NOW.getTime() - 30 * 24 * 60 * 60_000);
    const inA = makeTicket({ id: 'bdboard-dup', projectId: '/projects/a', updatedAt: stale });
    const inB = makeTicket({ id: 'bdboard-dup', projectId: '/projects/b', updatedAt: stale });

    const issues = checkHygiene([inA, inB], {
      now: NOW,
      pendingDecisionKeys: new Set([
        pendingDecisionKey('/projects/a', 'bdboard-dup'),
        pendingDecisionKey('/projects/b', 'bdboard-dup'),
      ]),
      // A にだけ新しいコメントがある。B は放置のまま出るべき。
      pendingCommentAnchors: new Map([
        [pendingDecisionKey('/projects/a', 'bdboard-dup'), new Date(NOW.getTime() - 60_000)],
      ]),
    }).filter((issue) => issue.kind === 'stale_pending_decision');

    expect(issues.map((issue) => issue.projectId)).toEqual(['/projects/b']);
  });

  it('still reports stale_in_progress when the ticket is not awaiting a human', () => {
    // 上の除外が「in_progress の検知そのものを殺した」になっていないことの確認。
    const ticket = makeTicket({
      id: 'bdboard-working',
      status: 'in_progress',
      startedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
      updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    const kinds = checkHygiene([ticket], {
      now: NOW,
      pendingDecisionKeys: keys('bdboard-someone-else'),
    }).map((issue) => issue.kind);

    expect(kinds).toContain('stale_in_progress');
  });
});
