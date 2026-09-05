export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'closed',
  'deferred',
  'pinned',
  'hooked',
] as const;

export type KnownStatus = (typeof TICKET_STATUSES)[number];
/** bd は `bd config set status.custom` で任意の status を足せるので、未知の文字列も通す */
export type Status = KnownStatus | (string & {});

export function isKnownStatus(value: unknown): value is KnownStatus {
  return (
    typeof value === 'string' &&
    (TICKET_STATUSES as readonly string[]).includes(value)
  );
}

export function isOpenLike(status: Status): boolean {
  return status === 'open' || status === 'pinned';
}

export const PRIORITIES = [0, 1, 2, 3, 4] as const;

export type Priority = (typeof PRIORITIES)[number];
