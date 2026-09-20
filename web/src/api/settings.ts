import { fetchJson } from './http';

export interface ScanRootsConfigDto {
  scanRoots: string[];
  excludePaths: string[];
  version: string;
  envOverride: boolean;
  defaultScanRoots: string[];
  envScanRoots: string[];
}

export function fetchScanRootsConfig(): Promise<ScanRootsConfigDto> {
  return fetchJson<ScanRootsConfigDto>('/api/settings/scan-roots');
}

export function putScanRootsConfig(config: {
  scanRoots: string[];
  excludePaths: string[];
  version: string;
}): Promise<{ scanRoots: string[]; excludePaths: string[]; version: string }> {
  return fetchJson<{ scanRoots: string[]; excludePaths: string[]; version: string }>('/api/settings/scan-roots', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface BoardThresholdsConfigDto {
  stalledAfterMs: number;
  livenessActiveMs: number;
  livenessIdleMs: number;
  livenessStaleMs: number;
  inProgressWipLimit: number | null;
  inProgressWipLimitByProject: Record<string, number>;
  version: string;
  defaults: {
    stalledAfterMs: number;
    livenessActiveMs: number;
    livenessIdleMs: number;
    livenessStaleMs: number;
    inProgressWipLimit: number | null;
    inProgressWipLimitByProject: Record<string, number>;
  };
}

export function fetchBoardThresholdsConfig(): Promise<BoardThresholdsConfigDto> {
  return fetchJson<BoardThresholdsConfigDto>('/api/settings/board-thresholds');
}

export function putBoardThresholdsConfig(config: {
  stalledAfterMs?: number;
  livenessActiveMs?: number;
  livenessIdleMs?: number;
  livenessStaleMs?: number;
  inProgressWipLimit?: number | null;
  inProgressWipLimitByProject?: Record<string, number>;
  version: string;
}): Promise<BoardThresholdsConfigDto> {
  return fetchJson<BoardThresholdsConfigDto>('/api/settings/board-thresholds', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface HygieneThresholdsConfigDto {
  staleInProgressAfterMs: number;
  highPriorityMax: number;
  stalePendingDecisionAfterMs: number;
  closedWithoutEvidenceWindowMs: number;
  version: string;
  defaults: {
    staleInProgressAfterMs: number;
    highPriorityMax: number;
    stalePendingDecisionAfterMs: number;
    closedWithoutEvidenceWindowMs: number;
  };
}

export function fetchHygieneThresholdsConfig(): Promise<HygieneThresholdsConfigDto> {
  return fetchJson<HygieneThresholdsConfigDto>('/api/settings/hygiene-thresholds');
}

export function putHygieneThresholdsConfig(config: {
  staleInProgressAfterMs?: number;
  highPriorityMax?: number;
  stalePendingDecisionAfterMs?: number;
  closedWithoutEvidenceWindowMs?: number;
  version: string;
}): Promise<HygieneThresholdsConfigDto> {
  return fetchJson<HygieneThresholdsConfigDto>('/api/settings/hygiene-thresholds', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface DbStatsDto {
  sizeBytes: number;
  tables: { name: string; rowCount: number }[];
}

export function fetchDbStats(): Promise<DbStatsDto> {
  return fetchJson<DbStatsDto>('/api/settings/db-stats');
}

export interface AiQuotaAlertConfigDto {
  thresholdPercent: number;
  version: string;
  defaults: { thresholdPercent: number };
}

export function fetchAiQuotaAlertConfig(): Promise<AiQuotaAlertConfigDto> {
  return fetchJson<AiQuotaAlertConfigDto>('/api/settings/ai-quota-alert');
}

export function putAiQuotaAlertConfig(config: {
  thresholdPercent: number;
  version: string;
}): Promise<AiQuotaAlertConfigDto> {
  return fetchJson<AiQuotaAlertConfigDto>('/api/settings/ai-quota-alert', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
}

export interface AiQuotaMetricDto {
  label: string;
  percentRemaining?: number;
  resetInText?: string;
  resetAt?: string;
  status?: 'available' | 'exhausted';
  valueText?: string;
}

export interface AiQuotaProviderDto {
  id: string;
  label: string;
  vendor?: string;
  plan?: string;
  availability: 'live' | 'manual' | 'unavailable';
  detail?: string;
  metrics: AiQuotaMetricDto[];
}

export type AiQuotaDto =
  | { state: 'ok'; fetchedAt: string; providers: AiQuotaProviderDto[] }
  | { state: 'error'; message: string };

export function fetchAiQuota(): Promise<AiQuotaDto> {
  return fetchJson<AiQuotaDto>('/api/ai-quota');
}

/** 新しいリリースの有無 (bdboard-70z.7)。`unknown` は「確認できなかった」で、
 *  無効化されている場合もこれになる。UI 側は黙る。 */
export type UpdateCheckDto =
  | { state: 'up-to-date'; currentVersion: string }
  | { state: 'unknown'; currentVersion: string }
  | {
      state: 'update-available';
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
    };

export function fetchUpdateCheck(): Promise<UpdateCheckDto> {
  return fetchJson<UpdateCheckDto>('/api/update-check');
}
