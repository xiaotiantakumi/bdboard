import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchAiQuota } from '../api';
import { usePopoverViewportClamp } from '../hooks/usePopoverViewportClamp';
import { badgeClassName, computeQuotaSummary } from './ai-quota/aiQuotaHelpers';
import { ManualProviderNote } from './ai-quota/ManualProviderNote';
import { ProviderChips } from './ai-quota/ProviderChips';
import { useExclusivePopover } from './PopoverCoordinator';

const AI_QUOTA_QUERY_KEY = ['ai-quota'] as const;
// サーバー側のキャッシュTTL(既定5分)と同じ周期でしか変わらないので、それより高頻度で
// ポーリングしても意味が無い。
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * ヘッダに常駐する、連携AIのクォータ残量ウィジェット。数値を自動取得できない
 * プロバイダは手動確認方法を開閉できる注記で案内する。取得に失敗した場合は非表示。
 */
export function AiQuotaWidget() {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const containerRef = useExclusivePopover('ai-quota', popoverOpen, setPopoverOpen);
  const popoverRef = usePopoverViewportClamp<HTMLDivElement>(popoverOpen);

  const query = useQuery({
    queryKey: AI_QUOTA_QUERY_KEY,
    queryFn: fetchAiQuota,
    retry: false,
    refetchInterval: POLL_INTERVAL_MS,
    // TUIを起動する重い取得なので、フォーカス復帰のたびに再実行しない。
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  if (query.isError || data === undefined || data.state === 'error') {
    return null;
  }

  const providers = data.state === 'ok' ? data.providers : [];
  const liveProviders = providers.filter((provider) => provider.availability === 'live');
  if (liveProviders.length === 0) {
    return null;
  }

  const { maxUsagePercent, isExhausted } = computeQuotaSummary(liveProviders);
  const manualProviders = providers.filter((provider) => provider.availability === 'manual');

  const badgeLabel = `AIクォータ ${maxUsagePercent}%使用`;

  return (
    <div
      ref={containerRef}
      className="ai-quota-widget header-group"
      aria-label="AIクォータ残量"
    >
      <button
        type="button"
        className={badgeClassName(maxUsagePercent, isExhausted)}
        aria-expanded={popoverOpen}
        aria-haspopup="dialog"
        onClick={() => {
          setPopoverOpen((open) => !open);
        }}
      >
        {badgeLabel}
      </button>

      {popoverOpen && (
        <div
          ref={popoverRef}
          className="ai-quota-popover"
          role="region"
          aria-label="AIクォータ詳細"
        >
          {liveProviders.map((provider) => (
            <ProviderChips key={provider.id} provider={provider} />
          ))}

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
