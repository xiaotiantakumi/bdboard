import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import type { HygieneThresholdsConfigPort } from '../../application/ports/hygiene-thresholds-config.js';
import {
  DEFAULT_HYGIENE_THRESHOLDS_OVERRIDES,
  resolveHygieneThresholds,
  validateHygieneThresholds,
} from '../../domain/hygiene-thresholds.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface HygieneThresholdsRoutesDeps {
  readonly store: HygieneThresholdsConfigPort;
  readonly writeAccess?: WriteGuardDeps;
}

const msFieldSchema = z.number().int().positive().optional();
const priorityFieldSchema = z.number().int().min(0).max(4).optional();

const hygieneThresholdsBodySchema = z.object({
  staleInProgressAfterMs: msFieldSchema,
  highPriorityMax: priorityFieldSchema,
  stalePendingDecisionAfterMs: msFieldSchema,
  version: z.string().min(1).max(256),
});

export function computeHygieneThresholdsVersion(
  config: Awaited<ReturnType<HygieneThresholdsConfigPort['read']>>,
): string {
  const normalized = config ?? {};
  return createHash('sha256')
    .update(
      JSON.stringify({
        staleInProgressAfterMs: normalized.staleInProgressAfterMs,
        highPriorityMax: normalized.highPriorityMax,
        stalePendingDecisionAfterMs: normalized.stalePendingDecisionAfterMs,
      }),
    )
    .digest('hex');
}

function toEffectiveDto(config: Awaited<ReturnType<HygieneThresholdsConfigPort['read']>>) {
  const resolved = resolveHygieneThresholds(config);
  return {
    staleInProgressAfterMs: resolved.staleInProgressAfterMs,
    highPriorityMax: resolved.highPriorityMax,
    stalePendingDecisionAfterMs: resolved.stalePendingDecisionAfterMs,
    defaults: DEFAULT_HYGIENE_THRESHOLDS_OVERRIDES,
  };
}

function mergeHygieneThresholdsConfig(
  current: Awaited<ReturnType<HygieneThresholdsConfigPort['read']>>,
  body: z.infer<typeof hygieneThresholdsBodySchema>,
) {
  const nextConfig = { ...(current ?? {}) };

  const fields = {
    staleInProgressAfterMs: body.staleInProgressAfterMs,
    highPriorityMax: body.highPriorityMax,
    stalePendingDecisionAfterMs: body.stalePendingDecisionAfterMs,
  } as const;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      nextConfig[key as keyof typeof fields] = value;
    }
  }

  return nextConfig;
}

export function createHygieneThresholdsRoutes(deps: HygieneThresholdsRoutesDeps): Hono {
  const app = new Hono();
  let mutex: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutex.then(fn, fn);
    mutex = result.catch(() => undefined);
    return result;
  }

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.get('/api/settings/hygiene-thresholds', async (c) => {
    const config = await deps.store.read();
    const effective = toEffectiveDto(config);
    return c.json({
      ...effective,
      version: computeHygieneThresholdsVersion(config),
    });
  });

  app.put('/api/settings/hygiene-thresholds', async (c) => {
    const parsed = await parseJsonBody(c, hygieneThresholdsBodySchema, {
      includeValidationDetails: true,
    });
    if (!parsed.ok) return parsed.response;

    return runExclusive(async () => {
      const currentConfig = await deps.store.read();
      const currentVersion = computeHygieneThresholdsVersion(currentConfig);
      if (parsed.data.version !== currentVersion) {
        return c.json(
          {
            error: 'hygiene thresholds config changed since read',
            requestedVersion: parsed.data.version,
            currentVersion,
          },
          409,
        );
      }

      const nextConfig = mergeHygieneThresholdsConfig(currentConfig, parsed.data);
      const validation = validateHygieneThresholds({
        staleInProgressAfterMs: nextConfig.staleInProgressAfterMs,
        highPriorityMax: nextConfig.highPriorityMax,
        stalePendingDecisionAfterMs: nextConfig.stalePendingDecisionAfterMs,
      });
      if (!validation.ok) {
        return c.json(
          {
            error: 'invalid hygiene thresholds',
            details: { errors: validation.errors },
          },
          400,
        );
      }

      try {
        await deps.store.write(nextConfig);
      } catch {
        return c.json({ error: 'failed to write hygiene thresholds config' }, 500);
      }

      const effective = toEffectiveDto(nextConfig);
      return c.json({
        ...effective,
        version: computeHygieneThresholdsVersion(nextConfig),
      });
    });
  });

  return app;
}
