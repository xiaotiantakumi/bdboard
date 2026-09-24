import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECLAIM_INTERVAL_MS, DEFAULT_RECLAIM_OLDER_THAN } from '../application/lease/reclaim-scheduler.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../interface/http/graceful-shutdown.js';
import { resolveConfigFilePath } from '../infrastructure/fs/config-path.js';
import {
  MainCheckoutDbPathRequiredError,
  resolveMainConfig,
  SharedStateDirectoryCollisionError,
} from './resolve-main-config.js';

const MAIN_CHECKOUT = '/Users/example/bdboard';
const LINKED_WORKTREE = '/Users/example/bdboard/.claude/worktrees/bdboard-21e7';

// configFilePath は resolveConfigFilePath() が platform (win32 の APPDATA 分岐) に応じて値を
// 変えるため、ここではリテラルにせず委譲先を直接呼ぶ (resolveConfigFilePath 自身の分岐は
// infrastructure/fs/config-path.test.ts が別途担保する)。verify-windows で実際に破綻したため
// (bdboard-n4fc)、POSIX 決め打ちのリテラルには戻さないこと。tunnelLogFilePath は
// resolveDefaultTunnelLogFilePath() 自体がプラットフォーム分岐を持たない (log-sink.ts 参照) ので
// リテラルで安全。
const DEFAULT_TUNNEL_LOG_FILE_PATH = path.join(os.homedir(), '.bdboard', 'logs', 'cloudflared-tunnel.log');

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
      tunnelLogFilePath: DEFAULT_TUNNEL_LOG_FILE_PATH,
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
    // bdboard-6h6n: resolveDbPath() now runs BDBOARD_DB through path.resolve(), so on
    // win32 a POSIX-style absolute literal like '/tmp/...' gets a drive letter prepended
    // (verify-windows caught this as a real regression when this test still compared
    // against the raw literal). Compare against path.resolve(...) of the same literal so
    // the assertion tracks resolveDbPath()'s actual (platform-dependent) behavior.
    expect(config.dbPath).toBe(path.resolve('/tmp/custom-cache.db'));
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
    // bdboard-6h6n: same win32 drive-letter reasoning as above -- resolve the literal the
    // same way resolveDbPath() does instead of comparing to the raw POSIX-style string.
    const expectedDbPath = path.resolve('/tmp/dedicated-copy.db');
    expect(config.dbPath).toBe(expectedDbPath);
    expect(config.configFilePath).toBe(path.join(path.dirname(expectedDbPath), 'config.json'));
    expect(config.tunnelLogFilePath).toBe(
      path.join(path.dirname(expectedDbPath), 'logs', 'cloudflared-tunnel.log'),
    );
  });

  it('keeps main checkout shared paths unchanged', () => {
    const config = resolveMainConfig(MAIN_CHECKOUT, false);
    expect(config.configFilePath).toBe(resolveConfigFilePath());
    expect(config.tunnelLogFilePath).toBe(DEFAULT_TUNNEL_LOG_FILE_PATH);
  });

  // bdboard-n4fc opus レビュー指摘: BDBOARD_DB が共有ディレクトリそのものを指すと、
  // config.json / tunnel log の退避先がまた実物と重なってしまう。exact なディレクトリ一致だけ拒否する。
  it('refuses a linked-worktree BDBOARD_DB placed directly in the shared ~/.bdboard directory', () => {
    process.env.BDBOARD_DB = path.join(os.homedir(), '.bdboard', 'wt-cache.db');
    expect(() => resolveMainConfig(LINKED_WORKTREE, true)).toThrow(SharedStateDirectoryCollisionError);
  });

  it('refuses a linked-worktree BDBOARD_DB placed directly in the shared config directory', () => {
    process.env.BDBOARD_DB = path.join(path.dirname(resolveConfigFilePath()), 'wt-cache.db');
    expect(() => resolveMainConfig(LINKED_WORKTREE, true)).toThrow(SharedStateDirectoryCollisionError);
  });

  it('allows a linked-worktree BDBOARD_DB in a subdirectory under the shared ~/.bdboard directory', () => {
    process.env.BDBOARD_DB = path.join(os.homedir(), '.bdboard', 'wt-bdboard-21e7', 'cache.db');
    const config = resolveMainConfig(LINKED_WORKTREE, true);
    expect(config.dbPath).toBe(process.env.BDBOARD_DB);
    expect(config.configFilePath).toBe(
      path.join(os.homedir(), '.bdboard', 'wt-bdboard-21e7', 'config.json'),
    );
  });

  it('does not apply the shared-directory collision guard outside a linked worktree', () => {
    process.env.BDBOARD_DB = path.join(os.homedir(), '.bdboard', 'wt-cache.db');
    expect(() => resolveMainConfig(MAIN_CHECKOUT, false)).not.toThrow();
  });
});

// bdboard-6h6n: resolveDbPath() previously returned a relative BDBOARD_DB value as-is, so
// config.json/tunnel-log's sibling directory (derived via path.dirname(dbPath)) stayed relative
// too and implicitly depended on process.cwd() wherever it was later consumed, instead of the
// cwd at startup. resolveDbPath() now pins BDBOARD_DB to an absolute path once, at resolution
// time (opus review nit on PR #695).
describe('resolveMainConfig relative BDBOARD_DB resolution (bdboard-6h6n)', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    delete process.env.BDBOARD_DB;
    process.chdir(originalCwd);
  });

  it('resolves a relative BDBOARD_DB against process.cwd() for a linked worktree', () => {
    process.env.BDBOARD_DB = path.join('relative-dir', 'cache.db');
    const config = resolveMainConfig(LINKED_WORKTREE, true);
    const expectedDbPath = path.resolve(process.cwd(), 'relative-dir', 'cache.db');

    expect(path.isAbsolute(config.dbPath)).toBe(true);
    expect(config.dbPath).toBe(expectedDbPath);
    expect(config.configFilePath).toBe(path.join(path.dirname(expectedDbPath), 'config.json'));
    expect(config.tunnelLogFilePath).toBe(
      path.join(path.dirname(expectedDbPath), 'logs', 'cloudflared-tunnel.log'),
    );
  });

  it('resolves a relative BDBOARD_DB against process.cwd() for a main checkout as well', () => {
    process.env.BDBOARD_DB = path.join('relative-dir', 'cache.db');
    const config = resolveMainConfig(MAIN_CHECKOUT, false);

    expect(config.dbPath).toBe(path.resolve(process.cwd(), 'relative-dir', 'cache.db'));
  });

  it('resolves the same relative BDBOARD_DB to different absolute paths depending on cwd at startup', () => {
    process.env.BDBOARD_DB = path.join('relative-dir', 'cache.db');
    const fromOriginalCwd = resolveMainConfig(LINKED_WORKTREE, true).dbPath;
    expect(fromOriginalCwd).toBe(path.resolve(process.cwd(), 'relative-dir', 'cache.db'));

    process.chdir(os.tmpdir());
    const fromTmpdirCwd = resolveMainConfig(LINKED_WORKTREE, true).dbPath;
    expect(fromTmpdirCwd).toBe(path.resolve(process.cwd(), 'relative-dir', 'cache.db'));

    expect(fromOriginalCwd).not.toBe(fromTmpdirCwd);
  });

  it('still throws SharedStateDirectoryCollisionError when a relative BDBOARD_DB resolves into the shared ~/.bdboard directory', () => {
    process.chdir(os.homedir());
    process.env.BDBOARD_DB = path.join('.bdboard', 'wt-cache.db');

    expect(() => resolveMainConfig(LINKED_WORKTREE, true)).toThrow(SharedStateDirectoryCollisionError);
  });
});

// bdboard-6h6n: MainCheckoutDbPathRequiredError previously said "linked worktree checkout"
// unconditionally, even though isLinkedWorktreeCheckout() also true-positives for a git
// submodule, a --separate-git-dir clone, or a worktree of a bare repo (opus review nit on PR
// #695). The message should describe the actual .git-is-a-file signal instead of asserting a
// specific checkout kind.
describe('MainCheckoutDbPathRequiredError message (bdboard-6h6n)', () => {
  afterEach(() => {
    delete process.env.BDBOARD_DB;
  });

  it('does not assert "linked worktree checkout" outright and names the alternative checkout kinds', () => {
    delete process.env.BDBOARD_DB;
    expect.assertions(3);
    try {
      resolveMainConfig(LINKED_WORKTREE, true);
    } catch (error) {
      expect(error).toBeInstanceOf(MainCheckoutDbPathRequiredError);
      const message = (error as Error).message;
      expect(message).not.toMatch(/is not set for linked worktree checkout/);
      expect(message).toContain('could also be a git submodule or a checkout created with --separate-git-dir');
    }
  });
});
