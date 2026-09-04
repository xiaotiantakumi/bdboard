import type { BoardCache } from '../ports/board-cache.js';
import type { ProjectWatchHandle } from '../ports/project-watcher.js';
import type { RunStore } from '../runner/run-store.js';
import type { TunnelService } from '../tunnel/tunnel-service.js';

/**
 * node-streaming-command-runner.ts の STOP_GRACE_MS(3s) + 1s のマージン。
 * createGracefulShutdown の DEFAULT_SHUTDOWN_TIMEOUT_MS(5s、graceful-shutdown.ts)
 * より短くしてあるので、通常はこちらが先に切り上がり、graceful shutdown 側の
 * 強制終了タイマーが先に発火することはない (bdboard-54be.1)。
 */
export const RUN_CANCEL_DRAIN_TIMEOUT_MS = 4_000;

/** close() だけを要求する構造的型。infra への import を持ち込まないための最小面。 */
export interface Closeable {
  readonly close: () => void;
}

export interface ShutdownDrainDeps {
  readonly runStore?: Pick<RunStore, 'cancelAllAndWait'>;
  readonly watchHandle: Pick<ProjectWatchHandle, 'stop'>;
  readonly tunnelService: Pick<TunnelService, 'shutdown'>;
  readonly cache: Pick<BoardCache, 'close'>;
  /**
   * sqlite 実装固有の close()。application ポートには載せず、main から配線する (bdboard-9dm)。
   *
   * BoardCache は port 自身が close() を持つ (board-cache.ts) ので「同じ流儀なら
   * ChatSessionRepository / ChatMessageRepository にも載せるべき」という指摘があったが、
   * 採らなかった (fable レビュー, bdboard-9dm): close() は sqlite 実装のリソース寿命の
   * 話であって chat リポジトリの契約ではなく、in-memory 実装と各テストの fake 全部に
   * no-op を強いるだけになる。さらに session/message は別型なので、ポートに載せても
   * ここの異種配列は結局 Closeable のままで解消しない。
   *
   * 名前 (chat 固有) と形 (汎用 Closeable) がずれている点は、型に名前を付けて明示する。
   */
  readonly chatRepositories?: readonly Closeable[];
}

/**
 * SIGTERM 等の graceful shutdown で server.close() の drain 待ちに絡む後始末を行う関数を返す。
 *
 * main.ts はモノリシックで export が無く vitest から直接テストできないため、
 * drain の配線を application 層へ切り出す (bdboard-zna)。前例: createWatchedProjectsSync (bdboard-3tw.85)。
 *
 * tunnelService には {@link TunnelService.stop} ではなく {@link TunnelService.shutdown} を呼ぶ。
 * 稼働中トンネルがあれば中断記録を残すのは shutdown() だけであり (bdboard-8v8)、
 * ここを stop() に戻すと SIGTERM 時の中断通知が無言で壊れる。
 * deps の型が Pick<TunnelService, 'shutdown'> なので stop() へ戻すと型エラーにもなる(二重防御)。
 *
 * 実行順序は runStore.cancelAllAndWait (任意) → tunnelService.shutdown → watchHandle.stop →
 * cache.close → chatRepositories[].close (任意) とする (bdboard-bch, bdboard-9dm)。
 * preview_stop 等でプロセスグループ全体に SIGTERM が届くと、cloudflared 子プロセスが
 * tunnelService.shutdown() より先に終了し onUnexpectedExit で state が 'on' から 'error' へ
 * 化けることがある。旧順序 (watchHandle.stop を先に await) だと chokidar の watcher.close()
 * 待ちの間にその割り込みが起き、後段の shutdown() で state.kind === 'on' が偽になり
 * markInterrupted() が呼ばれない。shutdown() を最初に置けば、state 判定とマーカー書き込みは
 * 最初の await 前の同期区間で完了し、このレースを実質的に防げる。watchHandle と tunnel は
 * 独立したリソースなので順序入れ替えに依存関係上の問題はない。
 *
 * 各ステップは個別に try/catch し、1件でも失敗しても残りを best-effort で実行する (bdboard-crw)。
 * 失敗があれば全ステップ完了後に {@link AggregateError} で reject する (errors は発生順)。
 * 全成功なら resolve する。
 *
 * message には失敗したステップ名だけでなく **各エラーの message も含める**。
 * 呼び出し側 (main.ts) の onError は `err.message` しかログに出さないため、
 * ここに理由を畳み込んでおかないと「どのステップが落ちたか」は分かっても
 * 「なぜ落ちたか」が失われる。AggregateError.errors を読むロジックを main.ts 側へ
 * 足す手もあるが、main.ts はテストできないのでこちらへ寄せている (bdboard-zna と同じ理由)。
 */
export function createShutdownDrain(deps: ShutdownDrainDeps): () => Promise<void> {
  return async (): Promise<void> => {
    const errors: Error[] = [];
    const failures: string[] = [];

    const record = (step: string, err: unknown): void => {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push(error);
      failures.push(`${step}: ${error.message}`);
    };

    if (deps.runStore !== undefined) {
      try {
        await deps.runStore.cancelAllAndWait(RUN_CANCEL_DRAIN_TIMEOUT_MS);
      } catch (err: unknown) {
        record('runStore.cancelAllAndWait', err);
      }
    }

    try {
      await deps.tunnelService.shutdown();
    } catch (err: unknown) {
      record('tunnelService.shutdown', err);
    }

    try {
      await deps.watchHandle.stop();
    } catch (err: unknown) {
      record('watchHandle.stop', err);
    }

    try {
      deps.cache.close();
    } catch (err: unknown) {
      record('cache.close', err);
    }

    if (deps.chatRepositories !== undefined) {
      deps.chatRepositories.forEach((repository, index) => {
        try {
          repository.close();
        } catch (err: unknown) {
          record(`chatRepositories[${index}].close`, err);
        }
      });
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `shutdown drain failed: ${failures.join('; ')}`,
      );
    }
  };
}
