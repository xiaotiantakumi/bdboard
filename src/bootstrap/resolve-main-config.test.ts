import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECLAIM_INTERVAL_MS, DEFAULT_RECLAIM_OLDER_THAN } from '../application/lease/reclaim-scheduler.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../interface/http/graceful-shutdown.js';
import { resolveMainConfig } from './resolve-main-config.js';

const ENV_KEYS = [
  'BDBOARD_INSTANCE_NONCE',
  'BDBOARD_PORT',
  'BDBOARD_HOST',
  'BDBOARD_DB',
  'BDBOARD_REFRESH_INTERVAL_MS',
  'BDBOARD_SESSION_INTERVAL_MS',
  'BDBOARD_TRANSCRIPT_INTERVAL_MS',
  'BDBOARD_SHUTDOWN_TIMEOUT_MS',
  'BDBOARD_CFD_SNAPSHOT_INTERVAL_MS',
  'BDBOARD_CFD_SNAPSHOT_RETENTION_DAYS',
  'BDBOARD_BD_PATH',
  'BDBOARD_GH_PATH',
  'BDBOARD_RECLAIM_ENABLED',
  'BDBOARD_RECLAIM_INTERVAL_MS',
  'BDBOARD_RECLAIM_OLDER_THAN',
] as const;

describe('resolveMainConfig (bdboard-sso1.86 move only, main.ts の env 解決を切り出したもの)', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('resolves every field to the same defaults main.ts used inline', () => {
    const config = resolveMainConfig();

    expect(config).toEqual({
      instanceNonce: undefined,
      bdVersionCheckTimeoutMs: 3_000,
      port: 8787,
      host: '127.0.0.1',
      dbPath: path.join(os.homedir(), '.bdboard', 'cache.db'),
      refreshIntervalMs: 300_000,
      sessionIntervalMs: 10_000,
      transcriptIntervalMs: 30_000,
      shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
      cfdSnapshotIntervalMs: 3_600_000,
      cfdSnapshotRetentionDays: 365,
      bdPath: 'bd',
      ghPath: 'gh',
      reclaimEnabled: true,
      reclaimIntervalMs: DEFAULT_RECLAIM_INTERVAL_MS,
      reclaimOlderThan: DEFAULT_RECLAIM_OLDER_THAN,
    });
  });

  it('flows env var overrides through to the resolved config', () => {
    process.env.BDBOARD_INSTANCE_NONCE = 'nonce-123';
    process.env.BDBOARD_PORT = '9999';
    process.env.BDBOARD_HOST = '0.0.0.0';
    process.env.BDBOARD_DB = '/tmp/custom-cache.db';
    process.env.BDBOARD_BD_PATH = '/opt/bin/bd';
    process.env.BDBOARD_GH_PATH = '/opt/bin/gh';
    process.env.BDBOARD_RECLAIM_ENABLED = '0';

    const config = resolveMainConfig();

    expect(config.instanceNonce).toBe('nonce-123');
    expect(config.port).toBe(9999);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dbPath).toBe('/tmp/custom-cache.db');
    expect(config.bdPath).toBe('/opt/bin/bd');
    expect(config.ghPath).toBe('/opt/bin/gh');
    expect(config.reclaimEnabled).toBe(false);
  });

  it('always resolves bdVersionCheckTimeoutMs to the fixed 3000ms (not env-configurable)', () => {
    expect(resolveMainConfig().bdVersionCheckTimeoutMs).toBe(3_000);
  });
});
