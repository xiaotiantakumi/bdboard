export const EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS = 900_000;
export const EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS = 300_000;
export const EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS = 86_400_000;
export const EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS = 60_000;
export const EXTERNAL_ISSUE_POLL_BACKOFF_CAP_MS = 3_600_000;
export const EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS = 60_000;
export const EXTERNAL_ISSUE_GH_CALLS_PER_HOUR = 12;
export const EXTERNAL_ISSUE_GH_CALL_WINDOW_MS = 3_600_000;
export const EXTERNAL_ISSUE_GH_MAX_PAGES = 3;

export function resolveExternalIssuePollIntervalMs(requestedMs: number): number {
  if (!Number.isFinite(requestedMs)) return EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS;
  return Math.min(EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS, Math.max(EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS, Math.trunc(requestedMs)));
}

export function nextExternalIssuePollDelayMs(options: {
  readonly baseMs: number;
  readonly previousMs: number;
  readonly errorKind: string | null;
}): number {
  if (options.errorKind !== 'rate-limited' && options.errorKind !== 'failed') return options.baseMs;
  return Math.min(Math.max(options.baseMs, EXTERNAL_ISSUE_POLL_BACKOFF_CAP_MS), options.previousMs * 2);
}
