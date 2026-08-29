import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { BoardCardDto } from '../api';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import { CardItem, LaneColumn } from './LaneColumn';
import { BulkSelectionProvider } from './BulkSelectionProvider';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

function renderWithWatch(ui: ReactElement) {
  return render(<WatchedTicketsProvider>{ui}</WatchedTicketsProvider>);
}

function makeCard(id: string): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title: 'Pending ticket',
      status: 'open',
      priority: 2,
      issueType: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane: 'ready',
    projectId: 'proj-1',
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: 2,
    priorityInheritedFrom: null,
  };
}

describe('CardItem pending decision badge', () => {
  it('shows the pending decision badge when hasPendingDecision is true', () => {
    renderWithWatch(
      <CardItem
        card={makeCard('bdboard-pending')}
        lane="ready"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('確認待ち')).toBeInTheDocument();
  });

  it('hides the pending decision badge when hasPendingDecision is false', () => {
    renderWithWatch(
      <CardItem
        card={makeCard('bdboard-plain')}
        lane="ready"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.queryByText('確認待ち')).not.toBeInTheDocument();
  });
});

describe('CardItem PR link badge', () => {
  it('shows the PR badge when prLink is provided', () => {
    renderWithWatch(
      <CardItem
        card={makeCard('bdboard-pr')}
        lane="ready"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        prLink={{
          ticketId: 'bdboard-pr',
          projectId: 'proj-1',
          url: 'https://github.com/example-org/example-repo/pull/42',
          state: 'open',
          checkStatus: null,
        }}
        onClick={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'PR open' })).toBeInTheDocument();
  });
});

// bdboard-ol9: defer バッジの日付。ISO 文字列を slice(0, 10) すると UTC の
// 日付になり、タイムゾーンによっては常に1日前を表示していた。日付境界は board の
// 設定タイムゾーンで整形する (bdboard-3tw.75 と同じ理由)。ここは CI(UTC)/ローカル
// のどちらで走っても同じ結果でなければならないので、host TZ に依存しないことを
// 併せて確かめている。
describe('CardItem defer date badge (bdboard-ol9)', () => {
  beforeEach(() => {
    setBoardTimeZoneOverride('Asia/Tokyo');
  });

  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('renders the defer date in the board timezone, not UTC', () => {
    // JST の 2027-08-29 00:00 ちょうど。UTC では前日の 15:00 になる。
    const card: BoardCardDto = {
      ...makeCard('bdboard-defer-tz'),
      ticket: {
        ...makeCard('bdboard-defer-tz').ticket,
        deferUntil: '2027-08-28T15:00:00.000Z',
      },
    };

    renderWithWatch(
      <CardItem
        card={card}
        lane="blocked"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('2027-08-29')).toBeInTheDocument();
    expect(screen.queryByText('2027-08-28')).not.toBeInTheDocument();
  });

  it('renders a UTC-midnight defer value on its own board-timezone date', () => {
    // bd の defer は「ローカル深夜の UTC 瞬間」(…T15:00:00Z) で入ることが多いが、
    // 経路によっては UTC 深夜 (…T00:00:00Z) のものもある。両方の形が正しい日付で
    // 出ることを固定しておく。
    //
    // 念のため: 手書きの +9h シフトでもこの2件は通る。ただしそれは「現代の
    // 日付では一致する」だけで等価ではない — 1948-51 年の夏時間 (JDT, UTC+10)
    // と 1888 年以前の LMT で食い違う (PR#124 fable レビューで counterexample
    // 提示、実測で確認)。defer 日付がその範囲に入ることは無いので、ここで
    // 歴史的な日付を fixture にしてまで +9h を殺すことはしない。
    const card: BoardCardDto = {
      ...makeCard('bdboard-defer-utc-midnight'),
      ticket: {
        ...makeCard('bdboard-defer-utc-midnight').ticket,
        deferUntil: '2026-12-15T00:00:00.000Z',
      },
    };

    renderWithWatch(
      <CardItem
        card={card}
        lane="blocked"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('2026-12-15')).toBeInTheDocument();
  });
});

// bdboard-662: 保留(deferred)はブロック(blocked)レーンへ表示統合された。その際に
// deferDays/deferUrgency の「あと何日」表示を失わないことが受け入れ条件のひとつ。
describe('CardItem defer countdown badge (bdboard-662 blocked/deferred merge)', () => {
  it('shows the defer countdown when lane is blocked and defer fields are set', () => {
    const card: BoardCardDto = {
      ...makeCard('bdboard-deferred'),
      deferDays: 5,
      deferUrgency: 'later',
    };

    renderWithWatch(
      <CardItem
        card={card}
        lane="blocked"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('あと5日')).toBeInTheDocument();
  });

  it('hides the defer countdown outside the blocked lane even when defer fields are set', () => {
    const card: BoardCardDto = {
      ...makeCard('bdboard-deferred-elsewhere'),
      deferDays: 5,
      deferUrgency: 'later',
    };

    renderWithWatch(
      <CardItem
        card={card}
        lane="ready"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.queryByText('あと5日')).not.toBeInTheDocument();
  });

  it('hides the defer countdown in the blocked lane when defer fields are null (dependency-blocked, not deferred)', () => {
    renderWithWatch(
      <CardItem
        card={makeCard('bdboard-dep-blocked')}
        lane="blocked"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.queryByText(/^あと\d+日$/)).not.toBeInTheDocument();
  });
});

describe('CardItem priority inheritance badge', () => {
  it('shows inherited priority badge with tooltip when priorityInheritedFrom is set', () => {
    const card: BoardCardDto = {
      ...makeCard('bdboard-inherited'),
      effectivePriority: 0,
      priorityInheritedFrom: 'bdboard-p0-downstream',
      ticket: {
        ...makeCard('bdboard-inherited').ticket,
        priority: 3,
      },
    };

    renderWithWatch(
      <CardItem
        card={card}
        lane="ready"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.getByText('P3→P0')).toBeInTheDocument();
    expect(screen.getByTitle('bdboard-p0-downstream')).toBeInTheDocument();
  });

  it('hides inherited priority badge when priorityInheritedFrom is null', () => {
    renderWithWatch(
      <CardItem
        card={makeCard('bdboard-plain-inherit')}
        lane="ready"
        showProjectName={false}
        projectName="Project One"
        activeSessionCount={0}
        hasPendingDecision={false}
        onClick={() => {}}
      />,
    );

    expect(screen.queryByText(/→P/)).not.toBeInTheDocument();
  });
});

describe('CardItem bulk selection checkbox', () => {
  it('does not open the detail panel when the checkbox is clicked', () => {
    const onClick = vi.fn();

    renderWithWatch(
      <BulkSelectionProvider>
        <CardItem
          card={makeCard('bdboard-bulk-click')}
          lane="ready"
          showProjectName={false}
          projectName="Project One"
          activeSessionCount={0}
          hasPendingDecision={false}
          onClick={onClick}
        />
      </BulkSelectionProvider>,
    );

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'bdboard-bulk-click を選択' }),
    );

    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps bulk checkbox state independent from keyboard focus aria-selected', () => {
    renderWithWatch(
      <BulkSelectionProvider>
        <CardItem
          card={makeCard('bdboard-bulk-aria')}
          lane="ready"
          showProjectName={false}
          projectName="Project One"
          activeSessionCount={0}
          hasPendingDecision={false}
          onClick={() => {}}
          nav={{
            tabIndex: 0,
            ariaSelected: true,
            cardRef: () => {},
            onFocus: () => {},
          }}
        />
      </BulkSelectionProvider>,
    );

    const card = screen.getByRole('option');
    expect(card).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('checkbox', { name: 'bdboard-bulk-aria を選択' }),
    ).not.toBeChecked();

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'bdboard-bulk-aria を選択' }),
    );

    expect(
      screen.getByRole('checkbox', { name: 'bdboard-bulk-aria を選択' }),
    ).toBeChecked();
    expect(card).toHaveAttribute('aria-selected', 'true');
    expect(card.className).toContain('card-bulk-selected');
  });
});

describe('CardItem keyboard activation (bdboard-4dl)', () => {
  function renderCard(id: string, onClick: () => void) {
    return renderWithWatch(
      <BulkSelectionProvider>
        <CardItem
          card={makeCard(id)}
          lane="ready"
          showProjectName={false}
          projectName="Project One"
          activeSessionCount={0}
          hasPendingDecision={false}
          onClick={onClick}
        />
      </BulkSelectionProvider>,
    );
  }

  it('toggles watch with Enter on the star without opening the detail panel', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderCard('bdboard-key-watch', onClick);

    const star = screen.getByRole('button', { name: 'ウォッチ' });
    star.focus();
    await user.keyboard('{Enter}');

    // keydown は article までバブルする。article 側が target を見ずに
    // preventDefault() すると、★ は反応せず詳細パネルだけが開いていた。
    expect(screen.getByRole('button', { name: 'ウォッチ解除' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(onClick).not.toHaveBeenCalled();
  });

  it('toggles the bulk checkbox with Space without opening the detail panel', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderCard('bdboard-key-bulk', onClick);

    const checkbox = screen.getByRole('checkbox', { name: 'bdboard-key-bulk を選択' });
    checkbox.focus();
    await user.keyboard('{ }');

    expect(checkbox).toBeChecked();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('still opens the detail panel with Enter and Space on the card itself', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderCard('bdboard-key-card', onClick);

    const card = screen.getByRole('button', { name: /Pending ticket/ });
    card.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ }');

    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onClick).toHaveBeenCalledWith('bdboard-key-card');
  });

  it('suppresses the Space default only for the card, not for its controls', () => {
    const onClick = vi.fn();
    renderCard('bdboard-key-default', onClick);

    // Space はページスクロールの既定動作を持つ。role="button" のカードでこれを
    // 止めないと、選択を動かすたびにボードが飛ぶ。逆にチェックボックス上の
    // Space を止めると、今度はチェックが入らなくなる (bdboard-4dl の元バグ)。
    // fireEvent は preventDefault されたとき false を返す。
    const card = screen.getByRole('button', { name: /Pending ticket/ });
    expect(fireEvent.keyDown(card, { key: ' ' })).toBe(false);

    const checkbox = screen.getByRole('checkbox', {
      name: 'bdboard-key-default を選択',
    });
    expect(fireEvent.keyDown(checkbox, { key: ' ' })).toBe(true);
  });
});

describe('LaneColumn collapse', () => {
  const emptyMaps = {
    projectNames: new Map<string, string>(),
    projectActiveSessions: new Map<string, number>(),
    pendingDecisionIds: new Set<string>(),
    prLinksById: new Map<string, never>(),
  };

  it('calls onToggleCollapse when the header is clicked', () => {
    const onToggleCollapse = vi.fn();

    renderWithWatch(
      <LaneColumn
        lane="ready"
        cards={[makeCard('bdboard-collapse-1')]}
        showProjectName={false}
        projectNames={emptyMaps.projectNames}
        projectActiveSessions={emptyMaps.projectActiveSessions}
        pendingDecisionIds={emptyMaps.pendingDecisionIds}
        prLinksById={emptyMaps.prLinksById}
        onCardClick={() => {}}
        onToggleCollapse={onToggleCollapse}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /着手可能/ }));

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('hides cards when collapsed but keeps the count badge visible', () => {
    renderWithWatch(
      <LaneColumn
        lane="ready"
        cards={[makeCard('bdboard-collapse-2'), makeCard('bdboard-collapse-3')]}
        showProjectName={false}
        projectNames={emptyMaps.projectNames}
        projectActiveSessions={emptyMaps.projectActiveSessions}
        pendingDecisionIds={emptyMaps.pendingDecisionIds}
        prLinksById={emptyMaps.prLinksById}
        onCardClick={() => {}}
        collapsed
      />,
    );

    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('bdboard-collapse-2')).not.toBeInTheDocument();
    expect(screen.queryByText('bdboard-collapse-3')).not.toBeInTheDocument();
  });

  it('sets aria-expanded opposite to collapsed', () => {
    const { rerender } = renderWithWatch(
      <LaneColumn
        lane="ready"
        cards={[makeCard('bdboard-collapse-4')]}
        showProjectName={false}
        projectNames={emptyMaps.projectNames}
        projectActiveSessions={emptyMaps.projectActiveSessions}
        pendingDecisionIds={emptyMaps.pendingDecisionIds}
        prLinksById={emptyMaps.prLinksById}
        onCardClick={() => {}}
        collapsed={false}
      />,
    );

    expect(screen.getByRole('button', { name: /着手可能/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    rerender(
      <WatchedTicketsProvider>
        <LaneColumn
          lane="ready"
          cards={[makeCard('bdboard-collapse-4')]}
          showProjectName={false}
          projectNames={emptyMaps.projectNames}
          projectActiveSessions={emptyMaps.projectActiveSessions}
          pendingDecisionIds={emptyMaps.pendingDecisionIds}
          prLinksById={emptyMaps.prLinksById}
          onCardClick={() => {}}
          collapsed
        />
      </WatchedTicketsProvider>,
    );

    expect(screen.getByRole('button', { name: /着手可能/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

describe('LaneColumn wip exceeded', () => {
  const emptyMaps = {
    projectNames: new Map<string, string>(),
    projectActiveSessions: new Map<string, number>(),
    pendingDecisionIds: new Set<string>(),
    prLinksById: new Map<string, never>(),
  };

  it('shows wip exceeded label and warning class on the in_progress header', () => {
    renderWithWatch(
      <LaneColumn
        lane="in_progress"
        cards={[makeCard('bdboard-wip-1'), makeCard('bdboard-wip-2')]}
        showProjectName={false}
        projectNames={emptyMaps.projectNames}
        projectActiveSessions={emptyMaps.projectActiveSessions}
        pendingDecisionIds={emptyMaps.pendingDecisionIds}
        prLinksById={emptyMaps.prLinksById}
        onCardClick={() => {}}
        wipStatus={{ limit: 1, count: 2, exceeded: true }}
      />,
    );

    expect(screen.getByText('WIP超過: 2/1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '進行中 (WIP超過: 2/1)' })).toHaveClass(
      'lane-header-wip-exceeded',
    );
  });
});
