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
import { WORKTREES_DIR } from '../domain/git-worktree.js';
import { envBoolDefaultTrue, envInt, envOptionalString, envString } from './env.js';

export function isLinkedWorktreeCheckout(repoRoot: string): boolean {
  const normalizedRepoRoot = repoRoot.split(path.sep).join('/');
  return normalizedRepoRoot.includes(`/${WORKTREES_DIR}/`);
}

export class MainCheckoutDbPathRequiredError extends Error {
  constructor(repoRoot: string) {
    super(
      `BDBOARD_DB is not set for linked worktree checkout "${repoRoot}". Startup is refused to avoid opening the same database as the resident server (~/.bdboard/cache.db). Set BDBOARD_DB to a dedicated database file (for example, a copy created with sqlite3 ~/.bdboard/cache.db ".backup '<path>'") and start again.`,
    );
    this.name = 'MainCheckoutDbPathRequiredError';
  }
}

function resolveDbPath(repoRoot: string): string {
  const configuredPath = envOptionalString('BDBOARD_DB');
  if (configuredPath !== undefined) return configuredPath;
  if (isLinkedWorktreeCheckout(repoRoot)) {
    // Refusal avoids the surprising lifecycle and staleness of an automatic database copy.
    throw new MainCheckoutDbPathRequiredError(repoRoot);
  }
  return path.join(os.homedir(), '.bdboard', 'cache.db');
}

export interface MainConfig {
  readonly instanceNonce: string | undefined;
  readonly bdVersionCheckTimeoutMs: number;
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
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
export function resolveMainConfig(repoRoot: string): MainConfig {
  return {
    instanceNonce: envOptionalString('BDBOARD_INSTANCE_NONCE'),
    bdVersionCheckTimeoutMs: 3_000,
    port: envInt('BDBOARD_PORT', 8787),
    host: envString('BDBOARD_HOST', '127.0.0.1'),
    dbPath: resolveDbPath(repoRoot),
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
