import type { AiQuotaMetricDto } from '../../api';
import { formatResetAt, percentChipClass, splitMetricLabel } from './aiQuotaHelpers';

export function MetricChip({ metric }: { metric: AiQuotaMetricDto }) {
  const { group, period } = splitMetricLabel(metric.label);
  const title = group !== undefined ? `${group} / ${metric.label}` : metric.label;

  if (metric.percentRemaining !== undefined) {
    const resetText =
      metric.resetAt !== undefined
        ? formatResetAt(metric.resetAt)
        : metric.resetInText;
    return (
      <span className={percentChipClass(metric.percentRemaining)} title={title}>
        {period} {metric.percentRemaining}%
        {resetText !== undefined && (
          <span className="ai-quota-chip-reset">〜{resetText}</span>
        )}
      </span>
    );
  }

  if (metric.status !== undefined) {
    const statusClass =
      metric.status === 'exhausted'
        ? 'ai-quota-chip ai-quota-chip-critical'
        : 'ai-quota-chip';
    return (
      <span className={statusClass} title={title}>
        {period} {metric.status === 'available' ? '空きあり' : '枯渇'}
      </span>
    );
  }

  if (metric.valueText !== undefined) {
    return (
      <span className="ai-quota-chip" title={title}>
        {metric.label} {metric.valueText}
      </span>
    );
  }

  return null;
}
