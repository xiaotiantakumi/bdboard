import { Hono } from 'hono';
import type { AiQuotaService, AiQuotaState } from '../../application/ai-quota/get-ai-quota.js';
import type {
  AiQuotaMetric,
  AiQuotaProviderSnapshot,
} from '../../application/ports/ai-quota-source.js';

export interface AiQuotaRoutesDeps {
  readonly aiQuotaService: AiQuotaService;
}

function toMetricJson(metric: AiQuotaMetric): Record<string, unknown> {
  const json: Record<string, unknown> = { label: metric.label };
  if (metric.percentRemaining !== undefined) {
    json.percentRemaining = metric.percentRemaining;
  }
  if (metric.resetInText !== undefined) {
    json.resetInText = metric.resetInText;
  }
  if (metric.resetAt !== undefined) {
    json.resetAt = metric.resetAt.toISOString();
  }
  if (metric.status !== undefined) {
    json.status = metric.status;
  }
  return json;
}

function toProviderJson(provider: AiQuotaProviderSnapshot): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: provider.id,
    label: provider.label,
    metrics: provider.metrics.map(toMetricJson),
  };
  if (provider.vendor !== undefined) {
    json.vendor = provider.vendor;
  }
  if (provider.plan !== undefined) {
    json.plan = provider.plan;
  }
  return json;
}

function toResponseJson(state: AiQuotaState): Record<string, unknown> {
  if (state.kind === 'error') {
    return { state: 'error', message: state.message };
  }
  return {
    state: 'ok',
    fetchedAt: state.fetchedAt.toISOString(),
    providers: state.providers.map(toProviderJson),
  };
}

export function createAiQuotaRoutes(deps: AiQuotaRoutesDeps): Hono {
  const app = new Hono();

  app.get('/api/ai-quota', async (c) => {
    const state = await deps.aiQuotaService.getSnapshot();
    return c.json(toResponseJson(state));
  });

  return app;
}
