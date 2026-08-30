import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UseNotificationEventsResult } from '../hooks/useNotificationEvents';
import { expectNoA11yViolations } from '../test/axe';
import { EventCenterPanel } from './EventCenterPanel';

function makeProps(
  overrides: Partial<UseNotificationEventsResult> = {},
): UseNotificationEventsResult {
  return {
    events: [],
    unreadCount: 0,
    lastReadAt: null,
    markAllRead: vi.fn(),
    notificationsEnabled: false,
    notificationsSupported: true,
    permission: 'default',
    enableNotifications: vi.fn(async () => {}),
    disableNotifications: vi.fn(),
    notificationDeliveryError: null,
    ...overrides,
  };
}

describe('EventCenterPanel', () => {
  it('shows unsupported message when notifications are not supported', () => {
    render(
      <EventCenterPanel
        {...makeProps({
          notificationsSupported: false,
          permission: 'unsupported',
        })}
      />,
    );

    expect(
      screen.getByText('このブラウザはデスクトップ通知に対応していません'),
    ).toBeInTheDocument();
  });

  it('shows empty state when there are no events', () => {
    render(<EventCenterPanel {...makeProps()} />);
    expect(screen.getByText('まだイベントはありません')).toBeInTheDocument();
  });

  it('has no a11y violations in the empty state', async () => {
    const { container } = render(<EventCenterPanel {...makeProps()} />);

    expect(screen.getByText('まだイベントはありません')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('lists events when present', () => {
    render(
      <EventCenterPanel
        {...makeProps({
          events: [
            {
              id: 'ticket_ready:bdboard-abc:2026-08-17T10:00:00.000Z',
              kind: 'ticket_ready',
              ticketId: 'bdboard-abc',
              title: 'Example ticket',
              occurredAt: '2026-08-17T10:00:00.000Z',
            },
          ],
          unreadCount: 1,
        })}
      />,
    );

    expect(screen.getByText('着手可能')).toBeInTheDocument();
    expect(screen.getByText('Example ticket (bdboard-abc)')).toBeInTheDocument();
  });

  it('lists ai_quota_threshold events when present', () => {
    render(
      <EventCenterPanel
        {...makeProps({
          events: [
            {
              id: 'ai_quota_threshold:codex:週次リクエスト:2026-08-17T11:00:00.000Z',
              kind: 'ai_quota_threshold',
              providerId: 'codex',
              providerLabel: 'Codex',
              metricLabel: '週次リクエスト',
              percentRemaining: 15,
              thresholdPercent: 20,
              occurredAt: '2026-08-17T11:00:00.000Z',
            },
          ],
          unreadCount: 1,
        })}
      />,
    );

    expect(screen.getByText('クォータ低下')).toBeInTheDocument();
    expect(screen.getByText('Codex 週次リクエスト 残り15%(閾値20%)')).toBeInTheDocument();
  });

  it('marks unread by occurredAt, not array index, when events are out of chronological order', () => {
    const lastReadAt = '2026-08-17T10:30:00.000Z';
    const { container } = render(
      <EventCenterPanel
        {...makeProps({
          lastReadAt,
          unreadCount: 1,
          events: [
            {
              id: 'ticket_ready:bdboard-old:2026-08-17T10:00:00.000Z',
              kind: 'ticket_ready',
              ticketId: 'bdboard-old',
              title: 'Older ticket',
              occurredAt: '2026-08-17T10:00:00.000Z',
            },
            {
              id: 'ticket_ready:bdboard-new:2026-08-17T11:00:00.000Z',
              kind: 'ticket_ready',
              ticketId: 'bdboard-new',
              title: 'Newer ticket',
              occurredAt: '2026-08-17T11:00:00.000Z',
            },
          ],
        })}
      />,
    );

    const items = container.querySelectorAll('.event-center-panel-item');
    expect(items).toHaveLength(2);

    const olderItem = items[0]!;
    const newerItem = items[1]!;

    expect(within(olderItem as HTMLElement).queryByLabelText('未読')).not.toBeInTheDocument();
    expect(olderItem.classList.contains('event-center-panel-item-unread')).toBe(false);

    expect(within(newerItem as HTMLElement).getByLabelText('未読')).toBeInTheDocument();
    expect(newerItem.classList.contains('event-center-panel-item-unread')).toBe(true);
  });

  it('shows notificationDeliveryError when delivery fails', () => {
    render(
      <EventCenterPanel
        {...makeProps({
          notificationsEnabled: true,
          permission: 'granted',
          notificationDeliveryError: 'Illegal constructor',
        })}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Illegal constructor');
    expect(alert).toHaveClass('event-center-panel-warning');
  });

  it('calls enableNotifications when the enable button is clicked', async () => {
    const user = userEvent.setup();
    const enableNotifications = vi.fn(async () => {});
    render(
      <EventCenterPanel
        {...makeProps({
          enableNotifications,
        })}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'デスクトップ通知を有効にする' }));
    expect(enableNotifications).toHaveBeenCalledOnce();
  });
});
