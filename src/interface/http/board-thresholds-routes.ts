import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BoardThresholdsConfigPort } from '../../application/ports/board-thresholds-config.js';
import {
  DEFAULT_BOARD_THRESHOLDS_OVERRIDES,
  resolveBoardThresholds,
  validateBoardThresholds,
} from '../../domain/board-thresholds.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface BoardThresholdsRoutesDeps {
  readonly store: BoardThresholdsConfigPort;
  readonly writeAccess?: WriteGuardDeps;
}

const thresholdFieldSchema = z.number().int().positive().optional();

const boardThresholdsBodySchema = z.object({
  stalledAfterMs: thresholdFieldSchema,
  livenessActiveMs: thresholdFieldSchema,
  livenessIdleMs: thresholdFieldSchema,
  livenessStaleMs: thresholdFieldSchema,
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
    defaults: { ...DEFAULT_BOARD_THRESHOLDS_OVERRIDES },
  };
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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = boardThresholdsBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body', details: parsed.error.flatten() }, 400);
    }

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

      const nextOverrides = {
        stalledAfterMs: parsed.data.stalledAfterMs,
        livenessActiveMs: parsed.data.livenessActiveMs,
        livenessIdleMs: parsed.data.livenessIdleMs,
        livenessStaleMs: parsed.data.livenessStaleMs,
      };
      const validation = validateBoardThresholds(nextOverrides);
      if (!validation.ok) {
        return c.json(
          {
            error: 'invalid board thresholds',
            details: { errors: validation.errors },
          },
          400,
        );
      }

      const nextConfig = {
        ...(currentConfig ?? {}),
        ...Object.fromEntries(
          Object.entries(nextOverrides).filter(([, value]) => value !== undefined),
        ),
      };

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
