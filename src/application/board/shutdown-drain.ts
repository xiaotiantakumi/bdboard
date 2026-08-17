import type { BoardCache } from '../ports/board-cache.js';
import type { ProjectWatchHandle } from '../ports/project-watcher.js';
import type { TunnelService } from '../tunnel/tunnel-service.js';

export interface ShutdownDrainDeps {
  readonly watchHandle: Pick<ProjectWatchHandle, 'stop'>;
  readonly tunnelService: Pick<TunnelService, 'shutdown'>;
  readonly cache: Pick<BoardCache, 'close'>;
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
      await deps.watchHandle.stop();
    } catch (err: unknown) {
      record('watchHandle.stop', err);
    }

    // 稼働中のトンネルがあれば中断記録を残してから off へ (bdboard-8v8)。
    try {
      await deps.tunnelService.shutdown();
    } catch (err: unknown) {
      record('tunnelService.shutdown', err);
    }

    try {
      deps.cache.close();
    } catch (err: unknown) {
      record('cache.close', err);
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `shutdown drain failed: ${failures.join('; ')}`,
      );
    }
  };
}
