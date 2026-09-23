import type { AiQuotaProviderDto } from '../../api';
import { getBoardTimeZone } from '../../boardTimeZone';

const PERIOD_LABELS: Record<string, string> = {
  Weekly: '週次',
  'Five Hour': '5時間',
  Hourly: '時間',
};

export function splitMetricLabel(label: string): { group?: string; period: string } {
  const match = label.match(/(Weekly|Five Hour|5h|Hourly) Limit(?: Remaining)?$/i);
  if (!match) {
    return { period: label };
  }
  const rawPeriod = match[1].toLowerCase();
  const period =
    rawPeriod === 'weekly'
      ? PERIOD_LABELS.Weekly
      : rawPeriod === 'five hour' || rawPeriod === '5h'
        ? PERIOD_LABELS['Five Hour']
        : PERIOD_LABELS.Hourly;
  const group = label.slice(0, match.index).trim();
  return { group: group.length > 0 ? group : undefined, period };
}

export function formatResetAt(resetAt: string): string {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return resetAt;
  }
  return date.toLocaleString([], {
    timeZone: getBoardTimeZone(),
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function percentChipClass(percent: number): string {
  if (percent <= 10) {
    return 'ai-quota-chip ai-quota-chip-critical';
  }
  if (percent <= 30) {
    return 'ai-quota-chip ai-quota-chip-warn';
  }
  return 'ai-quota-chip';
}

export function computeQuotaSummary(providers: AiQuotaProviderDto[]): {
  maxUsagePercent: number;
  isExhausted: boolean;
} {
  let maxUsagePercent = 0;
  let isExhausted = false;

  for (const provider of providers) {
    for (const metric of provider.metrics) {
      if (metric.percentRemaining !== undefined) {
        maxUsagePercent = Math.max(maxUsagePercent, 100 - metric.percentRemaining);
      }
      if (metric.status === 'exhausted') {
        isExhausted = true;
      }
    }
  }

  return { maxUsagePercent, isExhausted };
}

export function badgeClassName(maxUsagePercent: number, isExhausted: boolean): string {
  if (isExhausted || maxUsagePercent >= 100) {
    return 'ai-quota-badge ai-quota-badge-critical';
  }
  if (maxUsagePercent >= 90) {
    return 'ai-quota-badge ai-quota-badge-warn';
  }
  return 'ai-quota-badge';
}
