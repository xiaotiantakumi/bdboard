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

  if (metric.valueText !== undefined) {
    return (
      <span className="ai-quota-chip" title={title}>
        {metric.label} {metric.valueText}
      </span>
    );
  }

  return null;
}

function ProviderChips({ provider }: { provider: AiQuotaProviderDto }) {
  return (
    <div className="ai-quota-provider">
      <span className="ai-quota-provider-label">{provider.id}</span>
      {provider.metrics.map((metric, index) => (
        <MetricChip key={`${provider.id}-${index}`} metric={metric} />
      ))}
      {provider.availability !== 'live' && (
        <details className="ai-quota-note">
          <summary
            className={
              provider.availability === 'unavailable'
                ? 'ai-quota-chip ai-quota-chip-warn'
                : 'ai-quota-chip ai-quota-chip-manual'
            }
            aria-label={`${provider.label}: ${provider.detail ?? '数値を自動取得できません'}`}
          >
            {provider.availability === 'manual' ? '手動確認' : '取得失敗'}
          </summary>
          <span className="ai-quota-note-detail">
            {provider.detail ?? '数値を自動取得できません。対象サービスで確認してください。'}
          </span>
        </details>
      )}
    </div>
  );
}

function QuotaErrorNotice() {
  return (
    <div className="ai-quota-widget header-group" aria-label="AIクォータ残量">
      <div className="ai-quota-provider">
        <span className="ai-quota-provider-label">AI quota</span>
        <details className="ai-quota-note">
          <summary className="ai-quota-chip ai-quota-chip-warn">取得失敗</summary>
          <span className="ai-quota-note-detail">
            ai-quota コマンドを実行できませんでした。各CLIまたはダッシュボードで確認してください。
          </span>
        </details>
      </div>
    </div>
  );
}

/**
 * ヘッダに常駐する、連携AIのクォータ残量ウィジェット。数値を自動取得できない
 * プロバイダも、手動確認方法または取得失敗理由を開閉できる注記で案内する。
 */
export function AiQuotaWidget() {
  const query = useQuery({
    queryKey: AI_QUOTA_QUERY_KEY,
    queryFn: fetchAiQuota,
    retry: false,
    refetchInterval: POLL_INTERVAL_MS,
    // TUIを起動する重い取得なので、フォーカス復帰のたびに再実行しない。
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  if (query.isError) {
    return <QuotaErrorNotice />;
  }
  if (data === undefined) {
    return null;
  }

  if (data.state === 'error' || data.providers.length === 0) {
    return <QuotaErrorNotice />;
  }

  return (
    <div className="ai-quota-widget header-group" aria-label="AIクォータ残量">
      {data.providers.map((provider) => (
        <ProviderChips key={provider.id} provider={provider} />
      ))}
    </div>
  );
}
