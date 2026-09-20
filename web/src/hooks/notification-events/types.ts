import type { BoardCardDto, TicketDetailDto } from '../../api';

export interface NotificationEventItem {
  readonly id: string;
  readonly kind:
    | 'ticket_ready'
    | 'decision_pending'
    | 'session_died'
    | 'ai_quota_threshold'
    | 'watched_lane_changed'
    | 'watched_comment_changed'
    | 'watched_session_changed';
  readonly occurredAt: string;
  readonly ticketId?: string;
  readonly title?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly providerId?: string;
  readonly providerLabel?: string;
  readonly metricLabel?: string;
  readonly percentRemaining?: number;
  readonly thresholdPercent?: number;
  readonly resetAt?: string;
  readonly fromLane?: string;
  readonly toLane?: string;
  readonly previousCommentCount?: number;
  readonly commentCount?: number;
  readonly addedSessionIds?: readonly string[];
  readonly removedSessionIds?: readonly string[];
}

export interface UseNotificationEventsOptions {
  readonly watchedTicketIds?: ReadonlySet<string>;
  readonly boardCardsById?: ReadonlyMap<string, BoardCardDto>;
  readonly watchedTicketDetails?: ReadonlyMap<string, TicketDetailDto>;
}

export interface UseNotificationEventsResult {
  readonly events: readonly NotificationEventItem[];
  readonly unreadCount: number;
  readonly lastReadAt: string | null;
  readonly markAllRead: () => void;
  readonly notificationsEnabled: boolean;
  readonly notificationsSupported: boolean;
  readonly permission: NotificationPermission | 'unsupported';
  readonly enableNotifications: () => Promise<void>;
  readonly disableNotifications: () => void;
  /** Set when `new Notification()` fails (e.g. Android Chrome Illegal constructor). */
  readonly notificationDeliveryError: string | null;
}

export type TicketNotificationKind = 'ticket_ready' | 'decision_pending';

export type NotificationPayload = NotificationPayloadBody & {
  /** サーバーが再接続時に再送した通知 (bdboard-3tw.161)。 */
  readonly replayed?: boolean;
};

export type NotificationPayloadBody =
  | {
      kind: TicketNotificationKind;
      ticketId: string;
      title?: string;
      projectId?: string;
      occurredAt: string;
    }
  | {
      kind: 'session_died';
      sessionId: string;
      cwd: string;
      name?: string;
      lastActivityAt: string;
      occurredAt: string;
    }
  | {
      kind: 'ai_quota_threshold';
      providerId: string;
      providerLabel: string;
      metricLabel: string;
      percentRemaining: number;
      thresholdPercent: number;
      resetAt?: string;
      occurredAt: string;
    };
