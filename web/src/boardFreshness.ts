import type { StreamState } from './useBoardStream';

export type StatusLevel = 'ok' | 'delayed' | 'disconnected' | 'reconnecting';

export function formatGeneratedAtAge(generatedAt: string, nowMs: number): string {
  const ageMinutes = Math.floor((nowMs - new Date(generatedAt).getTime()) / 60000);
  if (ageMinutes < 1) {
    return 'たった今';
  }
  if (ageMinutes < 60) {
    return `${ageMinutes}分前`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  return `${ageHours}時間前`;
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
): StatusLevel {
  if (streamState === 'error') {
    return 'disconnected';
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
  return level === 'disconnected' || level === 'delayed' || level === 'reconnecting';
}

export const STATUS_LABELS: Record<StatusLevel, string> = {
  ok: '正常',
  delayed: '遅延',
  disconnected: '切断',
  reconnecting: '再接続中',
};
