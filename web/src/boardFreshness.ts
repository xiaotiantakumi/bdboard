import type { StreamState } from './useBoardStream';

export type StatusLevel = 'ok' | 'connecting' | 'delayed' | 'disconnected' | 'reconnecting';

/** ある時刻からの経過を「たった今 / N分前 / N時間前」で表す。 */
export function formatRelativeAge(timestampMs: number, nowMs: number): string {
  const ageMinutes = Math.floor((nowMs - timestampMs) / 60000);
  if (ageMinutes < 1) {
    return 'たった今';
  }
  if (ageMinutes < 60) {
    return `${ageMinutes}分前`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours}時間前`;
}

/**
 * ISO 8601 文字列で持っている時刻を {@link formatRelativeAge} と同じ表記に落とす。
 *
 * 元は generatedAt 専用だったが、lastRefreshAt (bdboard-3dr) が3つ目の用途に
 * なった時点で名前と実態が離れたので汎用名にした (bdboard-bn6)。
 */
export function formatIsoAge(isoTimestamp: string, nowMs: number): string {
  return formatRelativeAge(new Date(isoTimestamp).getTime(), nowMs);
}

export function contactAgeMinutes(lastContactAtMs: number, nowMs: number): number {
  return Math.floor((nowMs - lastContactAtMs) / 60000);
}

/**
 * SSE 接触時刻と盤面フェッチ成功時刻（react-query の dataUpdatedAt）を統合し、
 * 最も新しい正のタイムスタンプを返す。
 *
 * react-query の `dataUpdatedAt` はデータ未取得時 0 を返すため、0 以下の非正値は
 * 未接触（null / undefined と同様）として無視する。
 */
export function mergeLastServerContact(
  ...sources: Array<number | null | undefined>
): number | undefined {
  let max: number | undefined;
  for (const source of sources) {
    if (source !== null && source !== undefined && source > 0) {
      max = max === undefined ? source : Math.max(max, source);
    }
  }
  return max;
}

export function computeStatusLevel(
  streamState: StreamState,
  lastContactAtMs: number | null | undefined,
  nowMs: number,
  connectStalled = false,
): StatusLevel {
  if (streamState === 'error') {
    return 'disconnected';
  }
  if (connectStalled) {
    return 'connecting';
  }
  if (streamState === 'reconnecting') {
    return 'reconnecting';
  }
  if (lastContactAtMs !== null && lastContactAtMs !== undefined) {
    const ageMinutes = contactAgeMinutes(lastContactAtMs, nowMs);
    if (ageMinutes >= 2) {
      return 'delayed';
    }
  }
  return 'ok';
}

export function shouldShowAlertBar(level: StatusLevel): boolean {
  return (
    level === 'connecting' ||
    level === 'disconnected' ||
    level === 'delayed' ||
    level === 'reconnecting'
  );
}

export const STATUS_LABELS: Record<StatusLevel, string> = {
  ok: '正常',
  connecting: '接続待ち',
  delayed: '遅延',
  disconnected: '切断',
  reconnecting: '再接続中',
};
