import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ScanRootsConfig, ScanRootsConfigPort } from '../../application/ports/scan-roots-config.js';
import { stripTrailingSeparators, validateScanRoots } from '../../domain/scan-root-policy.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface ScanRootsRoutesDeps {
  readonly store: ScanRootsConfigPort;
  readonly resolveDefaultScanRoots: () => Promise<readonly string[]>;
  readonly writeAccess?: WriteGuardDeps;
  /** True when BDBOARD_SCAN_ROOTS is set, so any saved/PUT config here is currently ignored by
   *  discovery. Surfaced on GET so a future settings screen can warn the user instead of letting
   *  them edit a value that silently has no effect. */
  readonly isEnvOverridden?: boolean;
  /** Routes discovery actually uses when envOverride is true, so the UI can display it without contradiction. */
  readonly envScanRoots?: readonly string[];
}

const pathSchema = z.string().trim().min(1).max(4096);
// 保存時に末尾セパレータを正規化する(bdboard-4iw)。isExcluded は文字列比較なので
// '/path/' のまま保存すると under-exclude になる。ルート/ドライブルートの保持は
// domain の共有ヘルパ側で担保(S4: discover-projects の消費時正規化と同一実装)。
const excludePathSchema = pathSchema.transform(stripTrailingSeparators);
const scanRootsBodySchema = z.object({
  scanRoots: z.array(pathSchema).max(50),
  excludePaths: z.array(excludePathSchema).max(50).default([]),
  version: z.string().min(1).max(256),
});

/** The version is a deterministic fingerprint of the persisted content, not process state. */
export function computeVersion(config: ScanRootsConfig | undefined): string {
  const normalized = config ?? { scanRoots: [], excludePaths: [] };
  return createHash('sha256')
    .update(JSON.stringify({ scanRoots: normalized.scanRoots, excludePaths: normalized.excludePaths }))
    .digest('hex');
}

export function createScanRootsRoutes(deps: ScanRootsRoutesDeps): Hono {
  const app = new Hono();
  // Content hashes remain stable across restarts and detect edits made outside this process.
  // PUTs are serialized because the compare and write are separated by await boundaries. This
  // mutex only serializes writes within this process: a separate process or an external editor
  // can still write between our read and write, producing a last-writer-wins outcome. Hashing
  // narrows that window (it can no longer be won by a stale in-process version match) but does
  // not close it.
  let mutex: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutex.then(fn, fn);
    mutex = result.catch(() => undefined);
    return result;
  }
  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.get('/api/settings/scan-roots', async (c) => {
    const config = await deps.store.read();
    return c.json({
      ...(config ?? { scanRoots: [], excludePaths: [] }),
      version: computeVersion(config),
      defaultScanRoots: [
        ...(await deps.resolveDefaultScanRoots()),
      ],
      envOverride: deps.isEnvOverridden ?? false,
      envScanRoots: [...(deps.envScanRoots ?? [])],
    });
  });

  app.put('/api/settings/scan-roots', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = scanRootsBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request body', details: parsed.error.flatten() }, 400);
    }
    return runExclusive(async () => {
      const currentConfig = await deps.store.read();
      const currentVersion = computeVersion(currentConfig);
      if (parsed.data.version !== currentVersion) {
        return c.json(
          {
            error: 'scan roots config changed since read',
            requestedVersion: parsed.data.version,
            currentVersion,
          },
          409,
        );
      }
      // bdboard-bzd: ファイルシステムルートや既知のシステムディレクトリを scanRoots に
      // 設定できると、トンネル書き込み権限だけで全ファイルシステム走査を誘発できるため拒否する。
      const validation = validateScanRoots(parsed.data.scanRoots);
      if (!validation.ok) {
        return c.json(
          {
            error: 'dangerous scan root rejected',
            details: { rejected: validation.rejected },
          },
          400,
        );
      }
      const nextConfig = {
        scanRoots: parsed.data.scanRoots,
        excludePaths: parsed.data.excludePaths,
      };
      try {
        await deps.store.write(nextConfig);
      } catch {
        return c.json({ error: 'failed to write scan roots config' }, 500);
      }
      return c.json({
        ...nextConfig,
        version: computeVersion(nextConfig),
      });
    });
  });

  return app;
}
