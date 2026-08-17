/**
 * SIGTERM/SIGINT を受けたときの終了処理を main.ts から切り出し、単体テスト可能にする。
 *
 * 背景 (bdboard-3tw.91): Node の server.close() は、既存の全接続が閉じるまで解決しない。
 * bdboard は SSE (EventSource) で接続を張りっぱなしにするため、ブラウザのタブが開いている
 * 限り drain が終わらず、SIGTERM を送ってもプロセスが port を掴んだまま常駐し続ける実
 * インシデントが起きた。
 *
 * 対策:
 * - shutdown 開始と同時にタイムアウトタイマーを仕込む。一定時間内に drain(サーバー以外の
 *   後始末 + server.close() の解決)が終われば、タイマーをキャンセルして正常終了する
 *   (通常時のdrainを妨げない)。
 * - 時間内に終わらなければ server.closeAllConnections()(Node 18.2+)で SSE を含む
 *   既存接続を強制的に閉じたうえで、確実にプロセスを終了させる。
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/** Node の http.Server のうち、この処理が使う最小限の形。テストではフェイクに差し替える。 */
export interface GracefulShutdownServer {
  /** 全接続が閉じてから callback を呼ぶ (http.Server#close 相当) */
  close(callback: (err?: Error) => void): void;
  /** 既存の全接続を強制的に閉じる (http.Server#closeAllConnections 相当, Node 18.2+) */
  closeAllConnections(): void;
}

export interface GracefulShutdownDeps {
  /** ウォッチャー停止・トンネル停止・キャッシュクローズなど、サーバー以外の後始末 */
  readonly drain: () => Promise<void>;
  readonly server: GracefulShutdownServer;
  /** ミリ秒。この時間内に drain + server.close() が終わらなければ強制終了する */
  readonly timeoutMs?: number;
  readonly exit: (code: number) => void;
  /** テスト用の setTimeout/clearTimeout 差し替え。既定はグローバル */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
  /** drain() が reject したときに呼ばれる (プロセスは落とさず継続してタイムアウトに委ねる) */
  readonly onError?: (err: unknown) => void;
  /** タイムアウトで強制終了するときに呼ばれる */
  readonly onTimeout?: () => void;
}

export type ShutdownHandler = () => void;

/**
 * SIGTERM/SIGINT ハンドラを組み立てる。返り値を複数回呼んでも 2 回目以降は無視される
 * (二重 SIGTERM 対策。元の main.ts の `shuttingDown` フラグと同じ意図)。
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps): ShutdownHandler {
  const {
    drain,
    server,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    exit,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onError,
    onTimeout,
  } = deps;

  let shuttingDown = false;

  return () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    let settled = false;
    const finish = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeoutFn(timer);
      exit(code);
    };

    const timer = setTimeoutFn(() => {
      onTimeout?.();
      // drain が時間内に終わらなかった: SSE 等の張りっぱなし接続を強制的に閉じて
      // 確実にプロセスを終了させる。server.close() 自体がまだ解決していなくても、
      // ここで exit するので待たない。
      server.closeAllConnections();
      finish(1);
    }, timeoutMs);

    // タイマーがイベントループを生かし続けてプロセスの自然終了を妨げないようにする
    // (drain が既に終わっている経路では finish() が unref 前に呼ばれるため通常は無関係だが、
    // テスト環境やタイマー実装差を考慮した安全策)。
    const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof maybeUnref === 'function') {
      maybeUnref.call(timer);
    }

    void drain()
      .catch((err: unknown) => {
        onError?.(err);
      })
      .then(() => {
        server.close(() => {
          finish(0);
        });
      });
  };
}
