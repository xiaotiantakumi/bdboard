/**
 * bdboard-sso1.86: src/main.ts (composition root) から SIGINT/SIGTERM の
 * shutdown 配線 (drain → graceful shutdown → タイマー停止 → signal ハンドラ登録) を
 * 切り出したもの。runStore/chatRepositories を必須化した点を除けば、main.ts に
 * あった配線ロジックそのものの移動で挙動は変えていない (レビュー指摘で必須化のみ追加)。
 *
 * shutdownForSignal 内の後始末順序 (refresh → session → transcript → CFD snapshot →
 * ai-quota-alert のタイマー停止 → reclaimScheduler.stop() → shutdown()) は元の
 * main.ts と完全に同じ。drain 内部の順序 (runStore → tunnelService → watchHandle →
 * cache → chatRepositories) は application/board/shutdown-drain.ts 側の契約であり、
 * ここでは変えない。
 *
 * `registerSignalHandlers` は既定 true。テストで実際に process.on を張らずに
 * shutdownForSignal だけを直接呼んで検証できるよう false を渡せるようにしてある
 * (main.ts からの呼び出しは常に既定のまま)。
 */
import {
  createShutdownDrain,
  type ShutdownDrainDeps,
} from '../application/board/shutdown-drain.js';
import type { ReclaimScheduler } from '../application/lease/reclaim-scheduler.js';
import {
  createGracefulShutdown,
  type GracefulShutdownServer,
} from '../interface/http/graceful-shutdown.js';

/**
 * bdboard-sso1.86 レビュー指摘: ShutdownDrainDeps 側の runStore/chatRepositories は
 * (in-memory 実装やテストの都合で) optional だが、main.ts の配線では両方とも必ず
 * 実体を持つ値が揃っている。ここで必須化しておくことで、将来 main.ts 側の呼び出しで
 * どちらかを渡し忘れても型エラーで即気づける (テストと tsc だけでは検知できなかった -
 * 渡し忘れても drain 自体は残りのステップだけで正常終了してしまうため)。
 */
export interface WireShutdownDeps extends Omit<ShutdownDrainDeps, 'runStore' | 'chatRepositories'> {
  // NonNullable<ShutdownDrainDeps[...]> で必須化する: RunStore 型を直接 import すると
  // runner-reachability.test.ts の「ランナー dispatch 経路への参照は
  // interface/http/agent-run-routes.ts 経由の単一許可パスに限る」というトークン走査
  // ガードに引っかかる (bdboard-sso1.86 review で実際に検知)。ShutdownDrainDeps 側が
  // 既に持つ型をそのまま必須化するだけなら、新規 import を増やさずに済む。
  readonly runStore: NonNullable<ShutdownDrainDeps['runStore']>;
  readonly chatRepositories: NonNullable<ShutdownDrainDeps['chatRepositories']>;
  readonly server: GracefulShutdownServer;
  readonly shutdownTimeoutMs: number;
  readonly refreshIntervalTimer: ReturnType<typeof setInterval>;
  readonly sessionIntervalTimer: ReturnType<typeof setInterval> | null;
  readonly transcriptIntervalTimer: ReturnType<typeof setInterval> | undefined;
  readonly cfdSnapshotIntervalTimer: ReturnType<typeof setInterval> | undefined;
  readonly aiQuotaAlertIntervalTimer: ReturnType<typeof setInterval> | undefined;
  readonly reclaimScheduler: Pick<ReclaimScheduler, 'stop'>;
  readonly exit?: (code: number) => void;
  readonly log?: Pick<typeof console, 'error'>;
  /** 既定 true。テストで実シグナルを張らずに shutdownForSignal を直接呼ぶ場合は false。 */
  readonly registerSignalHandlers?: boolean;
}

export interface WireShutdownResult {
  readonly shutdownForSignal: () => void;
}

export function wireShutdown(deps: WireShutdownDeps): WireShutdownResult {
  const log = deps.log ?? console;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  // server.close() の解決を待たない後始末(タイマー類の停止)は即座に、SSE 等の張りっぱなし
  // 接続の drain 待ちが絡む後始末(watcher/tunnel/cache)は createGracefulShutdown の
  // drain に委ねてタイムアウト保護をかける (bdboard-3tw.91)。
  const drain = createShutdownDrain(deps);

  const shutdown = createGracefulShutdown({
    drain,
    server: deps.server,
    timeoutMs: deps.shutdownTimeoutMs,
    exit,
    onError: (err) => {
      const detail = err instanceof Error ? err.message : String(err);
      log.error(`Shutdown drain error: ${detail}`);
    },
    onTimeout: () => {
      log.error(
        `Shutdown did not drain within ${deps.shutdownTimeoutMs}ms; forcing existing connections (e.g. SSE) closed`,
      );
    },
  });

  const shutdownForSignal = (): void => {
    clearInterval(deps.refreshIntervalTimer);
    if (deps.sessionIntervalTimer !== null) {
      clearInterval(deps.sessionIntervalTimer);
    }
    if (deps.transcriptIntervalTimer !== undefined) {
      clearInterval(deps.transcriptIntervalTimer);
    }
    if (deps.cfdSnapshotIntervalTimer !== undefined) {
      clearInterval(deps.cfdSnapshotIntervalTimer);
    }
    if (deps.aiQuotaAlertIntervalTimer !== undefined) {
      clearInterval(deps.aiQuotaAlertIntervalTimer);
    }
    deps.reclaimScheduler.stop();
    shutdown();
  };

  if (deps.registerSignalHandlers ?? true) {
    process.on('SIGINT', shutdownForSignal);
    process.on('SIGTERM', shutdownForSignal);
  }

  return { shutdownForSignal };
}
