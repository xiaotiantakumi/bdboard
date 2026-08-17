import type { AiQuotaProviderSnapshot } from '../ports/ai-quota-source.js';

export interface AiQuotaThresholdAlertPayload {
  readonly kind: 'ai_quota_threshold';
  readonly providerId: string;
  readonly providerLabel: string;
  readonly metricLabel: string;
  readonly percentRemaining: number;
  readonly thresholdPercent: number;
  readonly resetAt?: string;
  readonly occurredAt: string;
}

export interface AiQuotaThresholdPublisher {
  /**
   * providers の各metricについて percentRemaining <= thresholdPercent なら閾値割れとみなす。
   * 同一 (providerId, metricLabel) の閾値割れは、
   *   (a) percentRemaining が thresholdPercent を上回って回復する、または
   *   (b) occurredAt が前回の閾値割れ検知時点で記録した metric.resetAt を過ぎる(=リセット時刻を跨ぐ)
   * のいずれかが起きるまで再発火しない。
   * percentRemaining が undefined のmetric(%が出ない status ベースの表示)は評価対象外(スキップ)。
   */
  collectBreaches(
    providers: readonly AiQuotaProviderSnapshot[],
    thresholdPercent: number,
    occurredAt: Date,
  ): readonly AiQuotaThresholdAlertPayload[];
}

export function createAiQuotaThresholdPublisher(): AiQuotaThresholdPublisher {
  const state = new Map<string, { resetAtMs: number | undefined }>();

  return {
    collectBreaches(
      providers: readonly AiQuotaProviderSnapshot[],
      thresholdPercent: number,
      occurredAt: Date,
    ): readonly AiQuotaThresholdAlertPayload[] {
      const payloads: AiQuotaThresholdAlertPayload[] = [];
      const occurredAtMs = occurredAt.getTime();

      for (const provider of providers) {
        for (const metric of provider.metrics) {
          if (metric.percentRemaining === undefined) {
            continue;
          }

          const key = `${provider.id}::${metric.label}`;
          const percentRemaining = metric.percentRemaining;

          if (percentRemaining > thresholdPercent) {
            state.delete(key);
            continue;
          }

          const existing = state.get(key);
          const nextResetAtMs = metric.resetAt?.getTime();

          const fire = (): void => {
            payloads.push({
              kind: 'ai_quota_threshold',
              providerId: provider.id,
              providerLabel: provider.label,
              metricLabel: metric.label,
              percentRemaining,
              thresholdPercent,
              ...(metric.resetAt !== undefined ? { resetAt: metric.resetAt.toISOString() } : {}),
              occurredAt: occurredAt.toISOString(),
            });
            state.set(key, { resetAtMs: nextResetAtMs });
          };

          if (existing === undefined) {
            fire();
          } else if (
            existing.resetAtMs !== undefined &&
            occurredAtMs >= existing.resetAtMs
          ) {
            fire();
          } else if (existing.resetAtMs === undefined && nextResetAtMs !== undefined) {
            state.set(key, { resetAtMs: nextResetAtMs });
          }
        }
      }

      return payloads;
    },
  };
}
