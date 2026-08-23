import type { StreamState } from './useBoardStream';

export type StatusLevel = 'ok' | 'delayed' | 'disconnected';

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

export function staleAgeMinutes(generatedAt: string, nowMs: number): number {
  return Math.floor((nowMs - new Date(generatedAt).getTime()) / 60000);
}

export function computeStatusLevel(
  streamState: StreamState,
  generatedAt: string | null | undefined,
  nowMs: number,
): StatusLevel {
  if (streamState === 'error') {
    return 'disconnected';
  }
  if (generatedAt !== null && generatedAt !== undefined) {
    const ageMinutes = staleAgeMinutes(generatedAt, nowMs);
    if (ageMinutes >= 2) {
      return 'delayed';
    }
  }
  return 'ok';
}

export function shouldShowAlertBar(level: StatusLevel): boolean {
  return level === 'disconnected' || level === 'delayed';
}

export const STATUS_LABELS: Record<StatusLevel, string> = {
  ok: '正常',
  delayed: '遅延',
  disconnected: '切断',
};
