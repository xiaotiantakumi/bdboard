import type { BoardCache } from '../ports/board-cache.js';
import type { ProjectWatchHandle } from '../ports/project-watcher.js';
import type { TunnelService } from '../tunnel/tunnel-service.js';

export interface ShutdownDrainDeps {
  readonly watchHandle: Pick<ProjectWatchHandle, 'stop'>;
  readonly tunnelService: Pick<TunnelService, 'shutdown'>;
  readonly cache: Pick<BoardCache, 'close'>;
  /** sqlite 実装固有の close()。application ポートには載せず、main から配線する (bdboard-9dm)。 */
  readonly chatRepositories?: readonly { readonly close: () => void }[];
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
 * 実行順序は tunnelService.shutdown → watchHandle.stop → cache.close →
 * chatRepositories[].close (任意) とする (bdboard-bch, bdboard-9dm)。
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
