import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import type { AiQuotaAlertConfigPort } from '../../application/ports/ai-quota-alert-config.js';
import {
  DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT,
  resolveAiQuotaAlertThresholdPercent,
  validateAiQuotaAlertThresholdPercent,
} from '../../domain/ai-quota-alert-thresholds.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface AiQuotaAlertRoutesDeps {
  readonly store: AiQuotaAlertConfigPort;
  readonly writeAccess?: WriteGuardDeps;
}

const aiQuotaAlertBodySchema = z.object({
  thresholdPercent: z.number().int().min(1).max(99),
  version: z.string().min(1).max(256),
});

export function computeAiQuotaAlertVersion(
  config: Awaited<ReturnType<AiQuotaAlertConfigPort['read']>>,
): string {
  const normalized = config ?? {};
  return createHash('sha256')
    .update(JSON.stringify({ thresholdPercent: normalized.thresholdPercent }))
    .digest('hex');
}

function toEffectiveDto(config: Awaited<ReturnType<AiQuotaAlertConfigPort['read']>>) {
  return {
    thresholdPercent: resolveAiQuotaAlertThresholdPercent(config),
    defaults: { thresholdPercent: DEFAULT_AI_QUOTA_ALERT_THRESHOLD_PERCENT },
  };
}

export function createAiQuotaAlertRoutes(deps: AiQuotaAlertRoutesDeps): Hono {
  const app = new Hono();
  let mutex: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutex.then(fn, fn);
    mutex = result.catch(() => undefined);
    return result;
  }

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.get('/api/settings/ai-quota-alert', async (c) => {
    const config = await deps.store.read();
    const effective = toEffectiveDto(config);
    return c.json({
      ...effective,
      version: computeAiQuotaAlertVersion(config),
    });
  });

  app.put('/api/settings/ai-quota-alert', async (c) => {
    const parsed = await parseJsonBody(c, aiQuotaAlertBodySchema, {
      includeValidationDetails: true,
    });
    if (!parsed.ok) return parsed.response;

    return runExclusive(async () => {
      const currentConfig = await deps.store.read();
      const currentVersion = computeAiQuotaAlertVersion(currentConfig);
      if (parsed.data.version !== currentVersion) {
        return c.json(
          {
            error: 'ai quota alert config changed since read',
            requestedVersion: parsed.data.version,
            currentVersion,
          },
          409,
        );
      }

      const validation = validateAiQuotaAlertThresholdPercent(parsed.data.thresholdPercent);
      if (!validation.ok) {
        return c.json(
          {
            error: 'invalid ai quota alert threshold',
            details: { errors: validation.errors },
          },
          400,
        );
      }

      const nextConfig = {
        ...(currentConfig ?? {}),
        thresholdPercent: parsed.data.thresholdPercent,
      };

      try {
        await deps.store.write(nextConfig);
      } catch {
        return c.json({ error: 'failed to write ai quota alert config' }, 500);
      }

      const effective = toEffectiveDto(nextConfig);
      return c.json({
        ...effective,
        version: computeAiQuotaAlertVersion(nextConfig),
      });
    });
  });

  return app;
}
