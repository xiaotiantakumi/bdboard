import {
  computeBoardNotificationSnapshot,
  type BoardSnapshotProjectInput,
} from '../../domain/board-notifications.js';
import type { CachedProject } from '../ports/board-cache.js';
import type { BoardNotificationPayload, BoardNotificationPublisher } from './board-notification-transitions.js';
import { refreshProjects, type RefreshProjectsDeps, type RefreshResult } from './refresh-projects.js';
import type { WatchedProjectsSync } from './sync-watched-projects.js';

/**
 * bdboard-sso1.9: src/main.ts (composition root) から `runRefresh` の合流 (coalescing)
 * 状態machine を移動しただけ (move only, 挙動変更ゼロ)。元の実装は main() 内のローカル
 * 変数・クロージャ (`refreshRunning` / `pendingRefresh` / `refreshWaiters` /
 * `mergePendingRefresh` / `runRefresh`) だった。
 *
 * `watchedProjectsSync` は元実装でも「watcher 作成 (= 初回リフレッシュの後) より前に
 * runRefresh を握るクロージャが作られる」ため、呼び出し時点で読む遅延束縛の
 * アクセサ (`getWatchedProjectsSync`) として受け取る — 元の「外側のミュータブル変数を
 * 呼び出し時に読む」挙動をそのまま再現するため。
 */

export function boardSnapshotInputFromCache(
  entries: readonly CachedProject[],
): readonly BoardSnapshotProjectInput[] {
  return entries.map((entry) => ({
    projectId: entry.project.id,
    tickets: entry.tickets,
    decisionPendingTicketIds: entry.pendingDecisions?.map((decision) => decision.id),
  }));
}

export interface RefreshRunnerDeps extends RefreshProjectsDeps {
  readonly boardNotificationPublisher: BoardNotificationPublisher;
  readonly publishBoardChanged: (data: {
    readonly refreshed: readonly string[];
    readonly reused: readonly string[];
    readonly removed: readonly string[];
  }) => void;
  readonly publishNotification: (payload: BoardNotificationPayload) => void;
  /** watcher 作成前は undefined を返してよい (元実装と同じ)。 */
  readonly getWatchedProjectsSync: () => WatchedProjectsSync | undefined;
  /** `status = updateStatusFromResult(cache, result, refreshedAt)` に相当する差し替え可能なフック。 */
  readonly onResult: (result: RefreshResult, refreshedAt: Date) => void;
  /** 省略時は `console.error` (元実装と同じメッセージ書式)。 */
  readonly onWatcherSyncError?: (err: unknown) => void;
}

export interface RefreshRunner {
  run(force?: boolean, onlyProjectIds?: readonly string[]): Promise<void>;
}

interface PendingRefresh {
  force: boolean;
  /** undefined = 全プロジェクト対象 */
  onlyProjectIds: Set<string> | undefined;
}

export function createRefreshRunner(deps: RefreshRunnerDeps): RefreshRunner {
  let refreshRunning = false;
  let pendingRefresh: PendingRefresh | undefined;
  const refreshWaiters: Array<() => void> = [];

  const mergePendingRefresh = (
    force: boolean,
    onlyProjectIds: readonly string[] | undefined,
  ): void => {
    if (pendingRefresh === undefined) {
      pendingRefresh = {
        force,
        onlyProjectIds: onlyProjectIds === undefined ? undefined : new Set(onlyProjectIds),
      };
      return;
    }
    if (force) {
      pendingRefresh.force = true;
    }
    if (onlyProjectIds === undefined) {
      // 「全プロジェクト対象」の要求が来たら、絞り込みは解除される(広い方が勝つ)
      pendingRefresh.onlyProjectIds = undefined;
    } else if (pendingRefresh.onlyProjectIds !== undefined) {
      for (const id of onlyProjectIds) {
        pendingRefresh.onlyProjectIds.add(id);
      }
    }
  };

  const logWatcherSyncError = (err: unknown): void => {
    if (deps.onWatcherSyncError !== undefined) {
      deps.onWatcherSyncError(err);
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Project watcher update error: ${detail}`);
  };

  return {
    async run(force = false, onlyProjectIds?: readonly string[]): Promise<void> {
      if (refreshRunning) {
        mergePendingRefresh(force, onlyProjectIds);

        return new Promise<void>((resolve) => {
          refreshWaiters.push(resolve);
        });
      }

      refreshRunning = true;
      mergePendingRefresh(force, onlyProjectIds);

      try {
        // pendingRefresh が空になるまで回す。通知発行 / watcher sync の await 中に
        // 届いた要求もここで拾う — 拾わずに finally へ抜けると、その要求の待ち手が
        // 「実行されないまま解決」され、書き込み直後の再取得が陳腐化キャッシュを掴む
        // (bdboard-6qs6 のバグ本体の再演)。入口で mergePendingRefresh() を呼んでいるので
        // 初回は必ず1周する。
        while (pendingRefresh !== undefined) {
          // 内側は連続して届いた要求の合流。1周ごとに1回だけ refreshProjects を呼ぶ。
          while (pendingRefresh !== undefined) {
            const current = pendingRefresh;
            // 実行中に届く要求を取りこぼさないよう、await に入る前にクリアする。
            pendingRefresh = undefined;

            const useOnlyProjectIds =
              current.onlyProjectIds === undefined ? undefined : [...current.onlyProjectIds];

            const result = await refreshProjects(
              {
                discovery: deps.discovery,
                repository: deps.repository,
                fingerprinter: deps.fingerprinter,
                cache: deps.cache,
                now: deps.now,
                humanDecisions: deps.humanDecisions,
              },
              {
                force: current.force,
                ...(useOnlyProjectIds !== undefined ? { onlyProjectIds: useOnlyProjectIds } : {}),
              },
            );

            deps.onResult(result, new Date());

            // Only announce a change when something actually changed. `bd --readonly`
            // still touches .beads/last-touched, so every refresh re-triggers the
            // watcher; without this guard each real change would emit a second,
            // empty board.changed event (refreshed=[] reused=all) to every client.
            if (result.refreshed.length > 0 || result.removed.length > 0) {
              deps.publishBoardChanged({
                refreshed: result.refreshed,
                reused: result.reused,
                removed: result.removed,
              });
            }
          }

          const cacheEntries = deps.cache.listProjects();
          const refreshAt = new Date();
          const notificationSnapshot = computeBoardNotificationSnapshot(
            boardSnapshotInputFromCache(cacheEntries),
            refreshAt,
          );
          for (const payload of deps.boardNotificationPublisher.collectTransitions(
            cacheEntries,
            notificationSnapshot,
            refreshAt,
          )) {
            deps.publishNotification(payload);
          }

          // discovery で増えた/消えたプロジェクトを監視対象に反映する。これが無いと
          // 起動後に現れたプロジェクトは定期リフレッシュ間隔ぶん遅れてしか画面に出ない。
          try {
            await deps.getWatchedProjectsSync()?.sync();
          } catch (err) {
            logWatcherSyncError(err);
          }
        }
      } finally {
        refreshRunning = false;
        const waiters = refreshWaiters.splice(0);
        for (const resolve of waiters) {
          resolve();
        }
      }
    },
  };
}
