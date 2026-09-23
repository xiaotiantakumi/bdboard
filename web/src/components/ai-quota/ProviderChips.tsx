import type { AiQuotaProviderDto } from '../../api';
import { MetricChip } from './MetricChip';

export function ProviderChips({ provider }: { provider: AiQuotaProviderDto }) {
  return (
    <div className="ai-quota-provider">
      <span className="ai-quota-provider-label">{provider.id}</span>
      {provider.metrics.map((metric, index) => (
        <MetricChip key={`${provider.id}-${index}`} metric={metric} />
      ))}
    </div>
  );
}
