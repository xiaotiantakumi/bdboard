export type AppEventName =
  | 'board.changed'
  | 'session.changed'
  | 'notification';

export interface AppEvent {
  readonly name: AppEventName;
  readonly data: unknown;
  /**
   * `notification` にだけハブが採番する SSE の event id (`<epoch>-<seq>`)。
   * 他のイベントには付かない (bdboard-3tw.161)。
   */
  readonly id?: string;
}

export interface EventHub {
  publish(event: AppEvent): void;
  subscribe(listener: (event: AppEvent) => void): () => void;
  subscriberCount(): number;
  /**
   * 直近に publish された `notification` のうち、`lastEventId` より新しいものを古い順に返す。
   * `lastEventId` が無い・解釈できない・別プロセス (再起動前) の id なら、保持分をすべて返す。
   */
  notificationsSince(lastEventId: string | null | undefined): readonly AppEvent[];
}

export interface EventHubOptions {
  /** 保持する `notification` の最大件数。既定 50。 */
  readonly notificationBufferSize?: number;
  /** id の接頭辞。プロセスごとに変わるので、再起動をまたいだ id を区別できる。 */
  readonly epoch?: string;
}

export const DEFAULT_NOTIFICATION_BUFFER_SIZE = 50;

interface BufferedNotification {
  readonly seq: number;
  readonly event: AppEvent;
}

function createEpoch(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * SSE の購読者にその場で配るだけだと、タブを閉じている間やモバイル PWA の
 * バックグラウンド中に出た通知は恒久的に失われる。`notification` だけはリングバッファに
 * 残し、再接続時に `notificationsSince()` で取り戻せるようにする (bdboard-3tw.161)。
 * バッファはメモリ上のみで、サーバー再起動をまたいだ分は戻らない。
 */
export function createEventHub(options: EventHubOptions = {}): EventHub {
  const listeners = new Set<(event: AppEvent) => void>();
  const bufferSize = Math.max(
    0,
    Math.floor(options.notificationBufferSize ?? DEFAULT_NOTIFICATION_BUFFER_SIZE),
  );
  const epoch = options.epoch ?? createEpoch();
  const idPrefix = `${epoch}-`;
  const buffer: BufferedNotification[] = [];
  let seq = 0;

  const stamp = (event: AppEvent): AppEvent => {
    if (event.name !== 'notification') {
      // 通知以外に id が付くとブラウザの Last-Event-ID が上書きされ、再送範囲が狂う。
      return event.id === undefined ? event : { name: event.name, data: event.data };
    }
    seq += 1;
    const stamped: AppEvent = { name: event.name, data: event.data, id: `${idPrefix}${seq}` };
    if (bufferSize > 0) {
      buffer.push({ seq, event: stamped });
      if (buffer.length > bufferSize) {
        buffer.splice(0, buffer.length - bufferSize);
      }
    }
    return stamped;
  };

  const parseSeq = (lastEventId: string | null | undefined): number | null => {
    if (typeof lastEventId !== 'string' || !lastEventId.startsWith(idPrefix)) {
      return null;
    }
    const rest = lastEventId.slice(idPrefix.length);
    if (!/^\d+$/.test(rest)) {
      return null;
    }
    return Number(rest);
  };

  return {
    publish(event: AppEvent): void {
      const delivered = stamp(event);
      for (const listener of listeners) {
        try {
          listener(delivered);
        } catch (err) {
          console.error(err);
        }
      }
    },

    subscribe(listener: (event: AppEvent) => void): () => void {
      listeners.add(listener);
      let active = true;

      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
      };
    },

    subscriberCount(): number {
      return listeners.size;
    },

    notificationsSince(lastEventId: string | null | undefined): readonly AppEvent[] {
      const after = parseSeq(lastEventId);
      const entries = after === null ? buffer : buffer.filter((entry) => entry.seq > after);
      return entries.map((entry) => entry.event);
    },
  };
}
