import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { fetchAiQuota, type AiQuotaMetricDto, type AiQuotaProviderDto } from '../api';

const AI_QUOTA_QUERY_KEY = ['ai-quota'] as const;
// サーバー側のキャッシュTTL(既定5分)と同じ周期でしか変わらないので、それより高頻度で
// ポーリングしても意味が無い。
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const QUOTA_FETCH_ERROR_DETAIL =
  'ai-quota コマンドを実行できませんでした。各CLIまたはダッシュボードで確認してください。';

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
    </div>
  );
}

function ManualProviderNote({ provider }: { provider: AiQuotaProviderDto }) {
  return (
    <div className="ai-quota-provider">
      <span className="ai-quota-provider-label">{provider.id}</span>
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
    </div>
  );
}

function computeQuotaSummary(providers: AiQuotaProviderDto[]): {
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

function badgeClassName(
  isFailure: boolean,
  maxUsagePercent: number,
  isExhausted: boolean,
): string {
  if (isFailure) {
    return 'ai-quota-badge ai-quota-badge-warn';
  }
  if (isExhausted || maxUsagePercent >= 100) {
    return 'ai-quota-badge ai-quota-badge-critical';
  }
  if (maxUsagePercent >= 90) {
    return 'ai-quota-badge ai-quota-badge-warn';
  }
  return 'ai-quota-badge';
}

/**
 * ヘッダに常駐する、連携AIのクォータ残量ウィジェット。数値を自動取得できない
 * プロバイダも、手動確認方法または取得失敗理由を開閉できる注記で案内する。
 */
export function AiQuotaWidget() {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: AI_QUOTA_QUERY_KEY,
    queryFn: fetchAiQuota,
    retry: false,
    refetchInterval: POLL_INTERVAL_MS,
    // TUIを起動する重い取得なので、フォーカス復帰のたびに再実行しない。
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!popoverOpen) {
      return;
    }

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (containerRef.current !== null && !containerRef.current.contains(target)) {
        setPopoverOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [popoverOpen]);

  const data = query.data;
  if (!query.isError && data === undefined) {
    return null;
  }

  const providers =
    data !== undefined && data.state === 'ok' ? data.providers : [];
  const isFailure =
    query.isError || data?.state === 'error' || providers.length === 0;
  const { maxUsagePercent, isExhausted } = computeQuotaSummary(providers);
  const liveProviders = providers.filter((provider) => provider.availability === 'live');
  const manualProviders = providers.filter(
    (provider) =>
      provider.availability === 'manual' || provider.availability === 'unavailable',
  );

  const badgeLabel = isFailure
    ? '取得失敗'
    : `AIクォータ ${maxUsagePercent}%使用`;

  return (
    <div
      ref={containerRef}
      className="ai-quota-widget header-group"
      aria-label="AIクォータ残量"
    >
      <button
        type="button"
        className={badgeClassName(isFailure, maxUsagePercent, isExhausted)}
        aria-expanded={popoverOpen}
        aria-haspopup="dialog"
        onClick={() => {
          setPopoverOpen((open) => !open);
        }}
      >
        {badgeLabel}
      </button>

      {popoverOpen && (
        <div className="ai-quota-popover" role="region" aria-label="AIクォータ詳細">
          {isFailure ? (
            <p className="ai-quota-popover-error">{QUOTA_FETCH_ERROR_DETAIL}</p>
          ) : (
            <>
              {liveProviders.map((provider) => (
                <ProviderChips key={provider.id} provider={provider} />
              ))}
            </>
          )}

          {manualProviders.length > 0 && (
            <div className="ai-quota-popover-manual">
              {manualProviders.map((provider) => (
                <ManualProviderNote key={provider.id} provider={provider} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
