import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BoardCardDto } from '../api';
import { CardItem } from './LaneColumn';

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
