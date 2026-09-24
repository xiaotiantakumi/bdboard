import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECLAIM_INTERVAL_MS, DEFAULT_RECLAIM_OLDER_THAN } from '../application/lease/reclaim-scheduler.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../interface/http/graceful-shutdown.js';
import { resolveConfigFilePath } from '../infrastructure/fs/config-path.js';
import { resolveDefaultTunnelLogFilePath } from '../infrastructure/process/cloudflared-tunnel/log-sink.js';
import { MainCheckoutDbPathRequiredError, resolveMainConfig } from './resolve-main-config.js';

const MAIN_CHECKOUT = '/Users/example/bdboard';
const LINKED_WORKTREE = '/Users/example/bdboard/.claude/worktrees/bdboard-21e7';

const ENV_KEYS = [
  'BDBOARD_INSTANCE_NONCE',
  'BDBOARD_PORT',
  'BDBOARD_HOST',
  'BDBOARD_DB',
  'BDBOARD_SCAN_ROOTS_CONFIG_PATH',
  'BDBOARD_BOARD_THRESHOLDS_CONFIG_PATH',
  'BDBOARD_HYGIENE_THRESHOLDS_CONFIG_PATH',
  'BDBOARD_AI_QUOTA_ALERT_CONFIG_PATH',
  'BDBOARD_TUNNEL_LOG_PATH',
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
    const config = resolveMainConfig(MAIN_CHECKOUT, false);

    expect(config).toEqual({
      instanceNonce: undefined,
      bdVersionCheckTimeoutMs: 3_000,
      port: 8787,
      host: '127.0.0.1',
      dbPath: path.join(os.homedir(), '.bdboard', 'cache.db'),
      configFilePath: resolveConfigFilePath(),
      tunnelLogFilePath: resolveDefaultTunnelLogFilePath(),
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

    const config = resolveMainConfig(MAIN_CHECKOUT, false);

    expect(config.instanceNonce).toBe('nonce-123');
    expect(config.port).toBe(9999);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dbPath).toBe('/tmp/custom-cache.db');
    expect(config.bdPath).toBe('/opt/bin/bd');
    expect(config.ghPath).toBe('/opt/bin/gh');
    expect(config.reclaimEnabled).toBe(false);
  });

  it('always resolves bdVersionCheckTimeoutMs to the fixed 3000ms (not env-configurable)', () => {
    expect(resolveMainConfig(MAIN_CHECKOUT, false).bdVersionCheckTimeoutMs).toBe(3_000);
  });
});

describe('resolveMainConfig dbPath resolution', () => {
  afterEach(() => {
    delete process.env.BDBOARD_DB;
  });

  it('requires a dedicated database path for a linked worktree when BDBOARD_DB is unset', () => {
    delete process.env.BDBOARD_DB;
    expect(() => resolveMainConfig(LINKED_WORKTREE, true)).toThrow(MainCheckoutDbPathRequiredError);
  });

  it('treats an empty BDBOARD_DB the same as unset for a linked worktree (matches envString semantics)', () => {
    process.env.BDBOARD_DB = '';
    expect(() => resolveMainConfig(LINKED_WORKTREE, true)).toThrow(MainCheckoutDbPathRequiredError);
  });

  it('uses an explicitly configured database path for a linked worktree', () => {
    process.env.BDBOARD_DB = '/tmp/dedicated-copy.db';
    const config = resolveMainConfig(LINKED_WORKTREE, true);
    expect(config.dbPath).toBe('/tmp/dedicated-copy.db');
    expect(config.configFilePath).toBe(path.join('/tmp', 'config.json'));
    expect(config.tunnelLogFilePath).toBe(path.join('/tmp', 'logs', 'cloudflared-tunnel.log'));
  });

  it('keeps main checkout shared paths unchanged', () => {
    const config = resolveMainConfig(MAIN_CHECKOUT, false);
    expect(config.configFilePath).toBe(resolveConfigFilePath());
    expect(config.tunnelLogFilePath).toBe(resolveDefaultTunnelLogFilePath());
  });
});
