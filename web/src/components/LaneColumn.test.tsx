import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardCardDto } from '../api';
import { CardItem, LaneColumn } from './LaneColumn';
import { BulkSelectionProvider } from './BulkSelectionProvider';

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
    render(
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
    render(
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
    render(
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

// bdboard-662: 保留(deferred)はブロック(blocked)レーンへ表示統合された。その際に
// deferDays/deferUrgency の「あと何日」表示を失わないことが受け入れ条件のひとつ。
describe('CardItem defer countdown badge (bdboard-662 blocked/deferred merge)', () => {
  it('shows the defer countdown when lane is blocked and defer fields are set', () => {
    const card: BoardCardDto = {
      ...makeCard('bdboard-deferred'),
      deferDays: 5,
      deferUrgency: 'later',
    };

    render(
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

    render(
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
    render(
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

    render(
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
    render(
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

    render(
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
    render(
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

describe('LaneColumn collapse', () => {
  const emptyMaps = {
    projectNames: new Map<string, string>(),
    projectActiveSessions: new Map<string, number>(),
    pendingDecisionIds: new Set<string>(),
    prLinksById: new Map<string, never>(),
  };

  it('calls onToggleCollapse when the header is clicked', () => {
    const onToggleCollapse = vi.fn();

    render(
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
    render(
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
    const { rerender } = render(
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
      />,
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
    render(
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
