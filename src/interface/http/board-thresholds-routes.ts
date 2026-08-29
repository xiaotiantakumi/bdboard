import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import type { BoardThresholdsConfigPort } from '../../application/ports/board-thresholds-config.js';
import {
  DEFAULT_BOARD_THRESHOLDS_OVERRIDES,
  resolveBoardThresholds,
  validateBoardThresholds,
} from '../../domain/board-thresholds.js';
import {
  DEFAULT_WIP_LIMITS_OVERRIDES,
  validateWipLimits,
} from '../../domain/wip-limits.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface BoardThresholdsRoutesDeps {
  readonly store: BoardThresholdsConfigPort;
  readonly writeAccess?: WriteGuardDeps;
}

const thresholdFieldSchema = z.number().int().positive().optional();
const wipLimitFieldSchema = z.union([z.number().int().positive(), z.null()]).optional();

const boardThresholdsBodySchema = z.object({
  stalledAfterMs: thresholdFieldSchema,
  livenessActiveMs: thresholdFieldSchema,
  livenessIdleMs: thresholdFieldSchema,
  livenessStaleMs: thresholdFieldSchema,
  inProgressWipLimit: wipLimitFieldSchema,
  inProgressWipLimitByProject: z
    .record(z.string().min(1), z.number().int().positive())
    .optional(),
  version: z.string().min(1).max(256),
});

export function computeBoardThresholdsVersion(
  config: Awaited<ReturnType<BoardThresholdsConfigPort['read']>>,
): string {
  const normalized = config ?? {};
  return createHash('sha256')
    .update(
      JSON.stringify({
        stalledAfterMs: normalized.stalledAfterMs,
        livenessActiveMs: normalized.livenessActiveMs,
        livenessIdleMs: normalized.livenessIdleMs,
        livenessStaleMs: normalized.livenessStaleMs,
        inProgressWipLimit: normalized.inProgressWipLimit ?? null,
        inProgressWipLimitByProject: normalized.inProgressWipLimitByProject ?? {},
      }),
    )
    .digest('hex');
}

function toEffectiveDto(config: Awaited<ReturnType<BoardThresholdsConfigPort['read']>>) {
  const resolved = resolveBoardThresholds(config);
  return {
    stalledAfterMs: resolved.stalledThresholds.stalledAfterMs,
    livenessActiveMs: resolved.livenessThresholds.activeMs,
    livenessIdleMs: resolved.livenessThresholds.idleMs,
    livenessStaleMs: resolved.livenessThresholds.staleMs,
    inProgressWipLimit: config?.inProgressWipLimit ?? null,
    inProgressWipLimitByProject: config?.inProgressWipLimitByProject ?? {},
    defaults: {
      ...DEFAULT_BOARD_THRESHOLDS_OVERRIDES,
      ...DEFAULT_WIP_LIMITS_OVERRIDES,
      inProgressWipLimit: null,
      inProgressWipLimitByProject: {},
    },
  };
}

function mergeBoardThresholdsConfig(
  current: Awaited<ReturnType<BoardThresholdsConfigPort['read']>>,
  body: z.infer<typeof boardThresholdsBodySchema>,
) {
  const nextConfig = { ...(current ?? {}) };

  const thresholdFields = {
    stalledAfterMs: body.stalledAfterMs,
    livenessActiveMs: body.livenessActiveMs,
    livenessIdleMs: body.livenessIdleMs,
    livenessStaleMs: body.livenessStaleMs,
  } as const;

  for (const [key, value] of Object.entries(thresholdFields)) {
    if (value !== undefined) {
      nextConfig[key as keyof typeof thresholdFields] = value;
    }
  }

  if (body.inProgressWipLimit !== undefined) {
    if (body.inProgressWipLimit === null) {
      delete nextConfig.inProgressWipLimit;
    } else {
      nextConfig.inProgressWipLimit = body.inProgressWipLimit;
    }
  }

  if (body.inProgressWipLimitByProject !== undefined) {
    nextConfig.inProgressWipLimitByProject = body.inProgressWipLimitByProject;
  }

  return nextConfig;
}

export function createBoardThresholdsRoutes(deps: BoardThresholdsRoutesDeps): Hono {
  const app = new Hono();
  let mutex: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutex.then(fn, fn);
    mutex = result.catch(() => undefined);
    return result;
  }

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.get('/api/settings/board-thresholds', async (c) => {
    const config = await deps.store.read();
    const effective = toEffectiveDto(config);
    return c.json({
      ...effective,
      version: computeBoardThresholdsVersion(config),
    });
  });

  app.put('/api/settings/board-thresholds', async (c) => {
    const parsed = await parseJsonBody(c, boardThresholdsBodySchema, {
      includeValidationDetails: true,
    });
    if (!parsed.ok) return parsed.response;

    return runExclusive(async () => {
      const currentConfig = await deps.store.read();
      const currentVersion = computeBoardThresholdsVersion(currentConfig);
      if (parsed.data.version !== currentVersion) {
        return c.json(
          {
            error: 'board thresholds config changed since read',
            requestedVersion: parsed.data.version,
            currentVersion,
          },
          409,
        );
      }

      const nextConfig = mergeBoardThresholdsConfig(currentConfig, parsed.data);
      const thresholdValidation = validateBoardThresholds({
        stalledAfterMs: nextConfig.stalledAfterMs,
        livenessActiveMs: nextConfig.livenessActiveMs,
        livenessIdleMs: nextConfig.livenessIdleMs,
        livenessStaleMs: nextConfig.livenessStaleMs,
      });
      const wipValidation = validateWipLimits({
        inProgressWipLimit: nextConfig.inProgressWipLimit,
        inProgressWipLimitByProject: nextConfig.inProgressWipLimitByProject,
      });
      const errors = [...thresholdValidation.errors, ...wipValidation.errors];
      if (errors.length > 0) {
        return c.json(
          {
            error: 'invalid board thresholds',
            details: { errors },
          },
          400,
        );
      }

      try {
        await deps.store.write(nextConfig);
      } catch {
        return c.json({ error: 'failed to write board thresholds config' }, 500);
      }

      const effective = toEffectiveDto(nextConfig);
      return c.json({
        ...effective,
        version: computeBoardThresholdsVersion(nextConfig),
      });
    });
  });

  return app;
}
