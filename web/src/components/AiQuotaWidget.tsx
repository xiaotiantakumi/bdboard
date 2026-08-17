import { useQuery } from '@tanstack/react-query';
import { fetchAiQuota, type AiQuotaMetricDto, type AiQuotaProviderDto } from '../api';

const AI_QUOTA_QUERY_KEY = ['ai-quota'] as const;
// サーバー側のキャッシュTTL(既定5分)と同じ周期でしか変わらないので、それより高頻度で
// ポーリングしても意味が無い。
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const PERIOD_LABELS: Record<string, string> = {
  Weekly: '週次',
  'Five Hour': '5時間',
  Hourly: '時間',
};

function splitMetricLabel(label: string): { group?: string; period: string } {
  const match = label.match(/(Weekly|Five Hour|Hourly) Limit Remaining$/);
  if (!match) {
    return { period: label };
  }
  const period = PERIOD_LABELS[match[1]] ?? match[1];
  const group = label.slice(0, match.index).trim();
  return { group: group.length > 0 ? group : undefined, period };
}

function formatResetAt(resetAt: string): string {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return resetAt;
  }
  return date.toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function percentChipClass(percent: number): string {
  if (percent <= 10) {
    return 'ai-quota-chip ai-quota-chip-critical';
  }
  if (percent <= 30) {
    return 'ai-quota-chip ai-quota-chip-warn';
  }
  return 'ai-quota-chip';
}

function MetricChip({ metric }: { metric: AiQuotaMetricDto }) {
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

  return null;
}

function ProviderChips({ provider }: { provider: AiQuotaProviderDto }) {
  return (
    <span className="ai-quota-provider">
      <span className="ai-quota-provider-label">{provider.id}</span>
      {provider.metrics.map((metric, index) => (
        <MetricChip key={`${provider.id}-${index}`} metric={metric} />
      ))}
    </span>
  );
}

/**
 * ヘッダに常駐する、連携AIのクォータ残量ウィジェット。`ai-quota` コマンドが無い/失敗する
 * 環境でもボードが壊れないよう、取得できない場合は静かに何も描画しない(非表示)。
 */
export function AiQuotaWidget() {
  const query = useQuery({
    queryKey: AI_QUOTA_QUERY_KEY,
    queryFn: fetchAiQuota,
    retry: false,
    refetchInterval: POLL_INTERVAL_MS,
    // 失敗を画面に出す機能ではないので、フォーカス復帰のたびに再取得しなくてよい。
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  if (data === undefined || data.state === 'error') {
    return null;
  }

  const providers = data.providers.filter((provider) => provider.metrics.length > 0);
  if (providers.length === 0) {
    return null;
  }

  return (
    <div className="ai-quota-widget header-group" aria-label="AIクォータ残量">
      {providers.map((provider) => (
        <ProviderChips key={provider.id} provider={provider} />
      ))}
    </div>
  );
}
