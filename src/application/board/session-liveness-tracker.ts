import { diffSessionLiveness } from '../../domain/board-notifications.js';
import type { AgentSession } from '../../domain/session.js';
import type { SessionRegistry } from '../ports/session-registry.js';
import {
  buildSessionDiedNotificationPayload,
  type SessionDiedNotificationPayload,
} from './board-notification-transitions.js';

/**
 * bdboard-sso1.9: src/main.ts (composition root) からセッション生死の定期取得・差分検知
 * ロジックを移動しただけ (move only, 挙動変更ゼロ)。元の実装は main() 内のローカル変数・
 * クロージャ (`sessions` / `previousSessionFingerprint` / `refreshSessions`) だった。
 */

export interface SessionLivenessTrackerDeps {
  readonly registry: SessionRegistry;
  readonly now: () => Date;
  /** died イベント1件ごとに呼ばれる (元実装どおり、died イベントの数だけ個別 publish する)。 */
  readonly publishSessionDied: (payload: SessionDiedNotificationPayload) => void;
  readonly publishSessionsChanged: (data: { count: number; activeCount: number }) => void;
  /** 省略時は `console.error` (元実装と同じメッセージ書式)。 */
  readonly onError?: (err: unknown) => void;
}

export interface SessionLivenessTracker {
  /**
   * registry からセッション一覧を再取得し、died イベント / 変更通知を publish する。
   * 例外は握りつぶし(元実装どおり)、内部状態は前回値のまま維持される。
   */
  refresh(): Promise<void>;
  /** 直近の refresh() で取得したセッション一覧 (初期値は空配列)。 */
  current(): readonly AgentSession[];
}

export function createSessionLivenessTracker(
  deps: SessionLivenessTrackerDeps,
): SessionLivenessTracker {
  let sessions: readonly AgentSession[] = [];
  let previousFingerprint: string | null = null;

  const logError = (err: unknown): void => {
    if (deps.onError !== undefined) {
      deps.onError(err);
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Session refresh error: ${detail}`);
  };

  return {
    async refresh(): Promise<void> {
      try {
        const prevSessions = sessions;
        const next = await deps.registry.listSessions();
        const fingerprint = JSON.stringify(
          next.map(
            (session) =>
              `${session.sessionId}:${session.alive}:${session.lastActivityAt.getTime()}`,
          ),
        );
        const changed =
          previousFingerprint !== null && fingerprint !== previousFingerprint;

        for (const diedEvent of diffSessionLiveness(prevSessions, next)) {
          deps.publishSessionDied(
            buildSessionDiedNotificationPayload(diedEvent, deps.now()),
          );
        }

        // Always take the newest snapshot: the fingerprint only covers the fields
        // clients react to (id/alive/lastActivityAt), not cwd/name/pid.
        sessions = next;
        previousFingerprint = fingerprint;

        if (changed) {
          deps.publishSessionsChanged({
            count: next.length,
            activeCount: next.filter((session) => session.alive).length,
          });
        }
      } catch (err) {
        logError(err);
      }
    },

    current(): readonly AgentSession[] {
      return sessions;
    },
  };
}
