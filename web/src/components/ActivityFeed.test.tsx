import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEventDto } from '../api';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import { ActivityFeed } from './ActivityFeed';
import { formatActivityDateHeading } from './activityFeedFormatting';

vi.mock('../api', () => ({
  fetchActivity: vi.fn(),
}));

import { fetchActivity } from '../api';

const fetchActivityMock = vi.mocked(fetchActivity);

const FIXED_NOW = new Date('2026-08-15T12:00:00+09:00');

function makeEvent(
  overrides: Partial<ActivityEventDto> & Pick<ActivityEventDto, 'id' | 'kind' | 'at'>,
): ActivityEventDto {
  return {
    projectId: 'proj-1',
    projectName: 'Project One',
    title: 'Sample ticket',
    status: 'open',
    priority: 2,
    issueType: 'task',
    ...overrides,
  };
}

function renderActivityFeed(
  options?: {
    projectIds?: readonly string[];
    windowDays?: 1 | 3 | 7;
    onWindowDaysChange?: (days: 1 | 3 | 7) => void;
    onSelectTicket?: (ticketId: string) => void;
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const onWindowDaysChange = options?.onWindowDaysChange ?? vi.fn();
  const onSelectTicket = options?.onSelectTicket ?? vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <ActivityFeed
        projectIds={options?.projectIds ?? []}
        windowDays={options?.windowDays ?? 1}
        onWindowDaysChange={onWindowDaysChange}
        onSelectTicket={onSelectTicket}
        now={FIXED_NOW}
      />
    </QueryClientProvider>,
  );

  return { onWindowDaysChange, onSelectTicket };
}

describe('ActivityFeed', () => {
  beforeEach(() => {
    fetchActivityMock.mockReset();
  });

  it('groups events under today and yesterday headings', async () => {
    fetchActivityMock.mockResolvedValue([
      makeEvent({
        id: 'bdboard-today',
        kind: 'created',
        at: '2026-08-15T03:00:00.000Z',
        title: 'Today ticket',
      }),
      makeEvent({
        id: 'bdboard-yesterday',
        kind: 'closed',
        at: '2026-08-14T03:00:00.000Z',
        title: 'Yesterday ticket',
      }),
      makeEvent({
        id: 'bdboard-older',
        kind: 'started',
        at: '2026-08-13T03:00:00.000Z',
        title: 'Older ticket',
      }),
    ]);

    renderActivityFeed();

    expect(await screen.findByRole('heading', { name: '今日' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '昨日' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2026-08-13' })).toBeInTheDocument();
    expect(screen.getByText('Today ticket')).toBeInTheDocument();
    expect(screen.getByText('Yesterday ticket')).toBeInTheDocument();
    expect(screen.getByText('Older ticket')).toBeInTheDocument();
  });

  it('shows kind badges for created, started, and closed', async () => {
    fetchActivityMock.mockResolvedValue([
      makeEvent({
        id: 'bdboard-created',
        kind: 'created',
        at: '2026-08-15T03:00:00.000Z',
      }),
      makeEvent({
        id: 'bdboard-started',
        kind: 'started',
        at: '2026-08-15T04:00:00.000Z',
      }),
      makeEvent({
        id: 'bdboard-closed',
        kind: 'closed',
        at: '2026-08-15T05:00:00.000Z',
      }),
    ]);

    renderActivityFeed();

    expect(await screen.findByText('作成')).toBeInTheDocument();
    expect(screen.getByText('着手')).toBeInTheDocument();
    expect(screen.getByText('完了')).toBeInTheDocument();
  });

  it('shows actor, change detail, and reason on the secondary line', async () => {
    fetchActivityMock.mockResolvedValue([
      makeEvent({
        id: 'bdboard-priority-change',
        kind: 'priority_changed',
        at: '2026-08-15T03:00:00.000Z',
        title: 'Priority changed ticket',
        actor: 'example-agent',
        from: '2',
        to: '1',
        reason: 'example priority reason',
      }),
    ]);

    renderActivityFeed();

    expect(await screen.findByText('優先度変更')).toBeInTheDocument();
    expect(
      screen.getByText('@example-agent · 2 → 1 · example priority reason'),
    ).toBeInTheDocument();
  });

  it('calls onSelectTicket with the clicked ticket id', async () => {
    const user = userEvent.setup();
    fetchActivityMock.mockResolvedValue([
      makeEvent({
        id: 'bdboard-click-me',
        kind: 'created',
        at: '2026-08-15T03:00:00.000Z',
        title: 'Clickable ticket',
      }),
    ]);

    const { onSelectTicket } = renderActivityFeed();

    await screen.findByText('Clickable ticket');
    await user.click(screen.getByRole('button', { name: /Clickable ticket/ }));

    expect(onSelectTicket).toHaveBeenCalledWith('bdboard-click-me');
  });

  it('shows an empty state when there are no events', async () => {
    fetchActivityMock.mockResolvedValue([]);

    renderActivityFeed();

    expect(await screen.findByText('この期間の動きはありません')).toBeInTheDocument();
  });

  it('passes projectIds to fetchActivity when provided', async () => {
    fetchActivityMock.mockResolvedValue([]);

    renderActivityFeed({ projectIds: ['proj-a', 'proj-b'], windowDays: 3 });

    await screen.findByText('この期間の動きはありません');

    expect(fetchActivityMock).toHaveBeenCalledWith(3, 100, ['proj-a', 'proj-b']);
  });
});

describe('formatActivityDateHeading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T12:00:00+09:00'));
    setBoardTimeZoneOverride('Asia/Tokyo');
  });

  afterEach(() => {
    vi.useRealTimers();
    resetBoardTimeZoneForTests();
  });

  it('uses relative labels for today and yesterday in the board timezone', () => {
    const now = new Date();
    expect(formatActivityDateHeading(new Date('2026-08-15T03:00:00+09:00'), now)).toBe(
      '今日',
    );
    expect(formatActivityDateHeading(new Date('2026-08-14T23:00:00+09:00'), now)).toBe(
      '昨日',
    );
    expect(formatActivityDateHeading(new Date('2026-08-13T12:00:00+09:00'), now)).toBe(
      '2026-08-13',
    );
  });
});
