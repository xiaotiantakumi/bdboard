import { validateString } from '../../uiPersistedState';
import type { NotificationEventItem, NotificationPayload, TicketNotificationKind } from './types';

function isTicketNotificationKind(kind: unknown): kind is TicketNotificationKind {
  return kind === 'ticket_ready' || kind === 'decision_pending';
}

export function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.occurredAt !== 'string') {
    return false;
  }
  if (isTicketNotificationKind(payload.kind)) {
    return typeof payload.ticketId === 'string';
  }
  if (payload.kind === 'session_died') {
    return typeof payload.sessionId === 'string' && typeof payload.cwd === 'string';
  }
  if (payload.kind === 'ai_quota_threshold') {
    return (
      typeof payload.providerId === 'string' &&
      typeof payload.providerLabel === 'string' &&
      typeof payload.metricLabel === 'string' &&
      typeof payload.percentRemaining === 'number' &&
      typeof payload.thresholdPercent === 'number'
    );
  }
  return false;
}

function validateNotificationEventItem(value: unknown): NotificationEventItem | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    (item.kind !== 'ticket_ready' &&
      item.kind !== 'decision_pending' &&
      item.kind !== 'session_died' &&
      item.kind !== 'ai_quota_threshold' &&
      item.kind !== 'watched_lane_changed' &&
      item.kind !== 'watched_comment_changed' &&
      item.kind !== 'watched_session_changed') ||
    typeof item.occurredAt !== 'string'
  ) {
    return null;
  }
  if (item.ticketId !== undefined && typeof item.ticketId !== 'string') {
    return null;
  }
  if (item.title !== undefined && typeof item.title !== 'string') {
    return null;
  }
  if (item.projectId !== undefined && typeof item.projectId !== 'string') {
    return null;
  }
  if (item.sessionId !== undefined && typeof item.sessionId !== 'string') {
    return null;
  }
  if (item.cwd !== undefined && typeof item.cwd !== 'string') {
    return null;
  }
  if (item.name !== undefined && typeof item.name !== 'string') {
    return null;
  }
  if (item.providerId !== undefined && typeof item.providerId !== 'string') {
    return null;
  }
  if (item.providerLabel !== undefined && typeof item.providerLabel !== 'string') {
    return null;
  }
  if (item.metricLabel !== undefined && typeof item.metricLabel !== 'string') {
    return null;
  }
  if (item.percentRemaining !== undefined && typeof item.percentRemaining !== 'number') {
    return null;
  }
  if (item.thresholdPercent !== undefined && typeof item.thresholdPercent !== 'number') {
    return null;
  }
  if (item.resetAt !== undefined && typeof item.resetAt !== 'string') {
    return null;
  }
  if (item.fromLane !== undefined && typeof item.fromLane !== 'string') {
    return null;
  }
  if (item.toLane !== undefined && typeof item.toLane !== 'string') {
    return null;
  }
  if (item.previousCommentCount !== undefined && typeof item.previousCommentCount !== 'number') {
    return null;
  }
  if (item.commentCount !== undefined && typeof item.commentCount !== 'number') {
    return null;
  }
  if (
    item.addedSessionIds !== undefined &&
    (!Array.isArray(item.addedSessionIds) ||
      !item.addedSessionIds.every((entry) => typeof entry === 'string'))
  ) {
    return null;
  }
  if (
    item.removedSessionIds !== undefined &&
    (!Array.isArray(item.removedSessionIds) ||
      !item.removedSessionIds.every((entry) => typeof entry === 'string'))
  ) {
    return null;
  }
  return value as NotificationEventItem;
}

export function validateNotificationEvents(value: unknown): NotificationEventItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: NotificationEventItem[] = [];
  for (const entry of value) {
    const validated = validateNotificationEventItem(entry);
    if (validated === null) {
      return null;
    }
    items.push(validated);
  }
  return items;
}

export function validateLastReadAt(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return validateString(value);
}
