/**
 * bdboard-sso1.86: src/main.ts (composition root) から起動時の env 解決
 * (port/host/dbPath など) を切り出したもの (move only, 挙動変更ゼロ)。
 *
 * I/O は一切行わない純粋関数。mkdirSync や各種サービスの生成 (副作用) は
 * wire-core-infra.ts 側が担う。
 */
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_RECLAIM_INTERVAL_MS,
  DEFAULT_RECLAIM_OLDER_THAN,
} from '../application/lease/reclaim-scheduler.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../interface/http/graceful-shutdown.js';
import { resolveConfigFilePath } from '../infrastructure/fs/config-path.js';
import { resolveDefaultTunnelLogFilePath } from '../infrastructure/process/cloudflared-tunnel/log-sink.js';
import { envBoolDefaultTrue, envInt, envOptionalString, envString } from './env.js';

export class MainCheckoutDbPathRequiredError extends Error {
  constructor(repoRoot: string) {
    super(
      // bdboard-6h6n: isLinkedWorktreeCheckout() only checks whether "<repoRoot>/.git" is a
      // file, which is also true for a git submodule, a `--separate-git-dir` clone, or a
      // worktree of a bare repo -- not only a `.claude/worktrees/*`-style linked worktree.
      // Don't claim "linked worktree" outright; describe the actual signal instead (opus
      // review nit on PR #695).
      `BDBOARD_DB is not set for "${repoRoot}", whose .git is a file rather than a directory (this checkout looks like a linked worktree, though it could also be a git submodule or a checkout created with --separate-git-dir). Startup is refused to avoid opening the same database as the resident server (~/.bdboard/cache.db). Set BDBOARD_DB to a dedicated database file (for example, a copy created with sqlite3 ~/.bdboard/cache.db ".backup '<path>'") and start again.`,
    );
    this.name = 'MainCheckoutDbPathRequiredError';
  }
}

/**
 * bdboard-n4fc: config.json / tunnel log は (dbPath が linked worktree で保護されている前提で)
 * dbPath と同じディレクトリに退避させて共有を避ける (resolveSharedConfigFilePath /
 * resolveSharedTunnelLogFilePath)。BDBOARD_DB がこの2つの実ディレクトリ自身を指すと、退避先が
 * 実物とまた重なってしまう (opus レビュー指摘, PR #695)。dbPath のディレクトリがどちらかの
 * 実ディレクトリそのものと一致する場合だけ拒否する (サブディレクトリなら重ならないので許可)。
 */
export class SharedStateDirectoryCollisionError extends Error {
  constructor(repoRoot: string, dbPath: string) {
    super(
      `BDBOARD_DB="${dbPath}" for linked worktree checkout "${repoRoot}" resolves to a directory that is itself a shared bdboard state directory. Placing the database there would still colocate config.json and the tunnel log with the resident server's real shared files. Choose a different directory (for example <worktree>/.tmp-db/cache.db) and start again.`,
    );
    this.name = 'SharedStateDirectoryCollisionError';
  }
}

function sharedStateDirectories(): readonly string[] {
  return [path.join(os.homedir(), '.bdboard'), path.dirname(resolveConfigFilePath())];
}

function collidesWithSharedStateDirectory(dbPath: string): boolean {
  const resolvedDbDir = path.resolve(path.dirname(dbPath));
  return sharedStateDirectories().some((dir) => path.resolve(dir) === resolvedDbDir);
}

function resolveDbPath(repoRoot: string, isLinkedWorktreeCheckout: boolean): string {
  const configuredPath = envOptionalString('BDBOARD_DB');
  if (configuredPath !== undefined) {
    // bdboard-6h6n: pin BDBOARD_DB to an absolute path once, here, at resolution time. A
    // relative value would otherwise flow into dbPath (and from there into
    // resolveSharedConfigFilePath/resolveSharedTunnelLogFilePath below via path.dirname(dbPath))
    // still relative, so config.json/tunnel-log's sibling directory would silently depend on
    // whatever process.cwd() happens to be wherever those paths get consumed, instead of the cwd
    // at startup. collidesWithSharedStateDirectory() already resolves internally, so this does
    // not change collision detection -- it only makes the *returned* dbPath (and everything
    // derived from it) consistent.
    const resolvedPath = path.resolve(configuredPath);
    if (isLinkedWorktreeCheckout && collidesWithSharedStateDirectory(resolvedPath)) {
      throw new SharedStateDirectoryCollisionError(repoRoot, resolvedPath);
    }
    return resolvedPath;
  }
  if (isLinkedWorktreeCheckout) {
    // Refusal avoids the surprising lifecycle and staleness of an automatic database copy.
    throw new MainCheckoutDbPathRequiredError(repoRoot);
  }
  return path.join(os.homedir(), '.bdboard', 'cache.db');
}

// Shared settings can be written from the UI, so linked checkouts keep them beside their DB.
function resolveSharedConfigFilePath(dbPath: string, isLinkedWorktreeCheckout: boolean): string {
  return isLinkedWorktreeCheckout ? path.join(path.dirname(dbPath), 'config.json') : resolveConfigFilePath();
}

// Tunnel startup writes logs; linked checkouts keep those writes beside their DB as well.
function resolveSharedTunnelLogFilePath(dbPath: string, isLinkedWorktreeCheckout: boolean): string {
  return isLinkedWorktreeCheckout
    ? path.join(path.dirname(dbPath), 'logs', 'cloudflared-tunnel.log')
    : resolveDefaultTunnelLogFilePath();
}

export interface MainConfig {
  readonly instanceNonce: string | undefined;
  readonly bdVersionCheckTimeoutMs: number;
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly configFilePath: string;
  readonly tunnelLogFilePath: string;
  readonly refreshIntervalMs: number;
  readonly sessionIntervalMs: number;
  readonly transcriptIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly cfdSnapshotIntervalMs: number;
  readonly cfdSnapshotRetentionDays: number;
  readonly bdPath: string;
  readonly ghPath: string;
  readonly reclaimEnabled: boolean;
  readonly reclaimIntervalMs: number;
  readonly reclaimOlderThan: string;
}

/** main() 冒頭の env 読み取り一式。process.env を直接見る (bootstrap/env.ts と同じ流儀)。 */
export function resolveMainConfig(repoRoot: string, isLinkedWorktreeCheckout: boolean): MainConfig {
  const dbPath = resolveDbPath(repoRoot, isLinkedWorktreeCheckout);
  return {
    instanceNonce: envOptionalString('BDBOARD_INSTANCE_NONCE'),
    bdVersionCheckTimeoutMs: 3_000,
    port: envInt('BDBOARD_PORT', 8787),
    host: envString('BDBOARD_HOST', '127.0.0.1'),
    dbPath,
    configFilePath: resolveSharedConfigFilePath(dbPath, isLinkedWorktreeCheckout),
    tunnelLogFilePath: resolveSharedTunnelLogFilePath(dbPath, isLinkedWorktreeCheckout),
    refreshIntervalMs: envInt('BDBOARD_REFRESH_INTERVAL_MS', 300_000),
    sessionIntervalMs: envInt('BDBOARD_SESSION_INTERVAL_MS', 10_000),
    transcriptIntervalMs: envInt('BDBOARD_TRANSCRIPT_INTERVAL_MS', 30_000),
    shutdownTimeoutMs: envInt('BDBOARD_SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS),
    cfdSnapshotIntervalMs: envInt('BDBOARD_CFD_SNAPSHOT_INTERVAL_MS', 3_600_000),
    cfdSnapshotRetentionDays: envInt('BDBOARD_CFD_SNAPSHOT_RETENTION_DAYS', 365),
    bdPath: envString('BDBOARD_BD_PATH', 'bd'),
    ghPath: envString('BDBOARD_GH_PATH', 'gh'),
    reclaimEnabled: envBoolDefaultTrue('BDBOARD_RECLAIM_ENABLED'),
    reclaimIntervalMs: envInt('BDBOARD_RECLAIM_INTERVAL_MS', DEFAULT_RECLAIM_INTERVAL_MS),
    reclaimOlderThan: envString('BDBOARD_RECLAIM_OLDER_THAN', DEFAULT_RECLAIM_OLDER_THAN),
  };
}
