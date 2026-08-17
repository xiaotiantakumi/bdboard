import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UseNotificationEventsResult } from '../hooks/useNotificationEvents';
import { EventCenterPanel } from './EventCenterPanel';

function makeProps(
  overrides: Partial<UseNotificationEventsResult> = {},
): UseNotificationEventsResult {
  return {
    events: [],
    unreadCount: 0,
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
