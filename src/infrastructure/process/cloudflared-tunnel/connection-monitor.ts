// bdboard-7yfj.8: cloudflared の出力行から「エッジとの接続が全部落ちた」状態を検出する。
// cloudflared は quick tunnel で複数本 (通常 4 本、connIndex=0..3) の接続を張る。
//   登録:   "Registered tunnel connection connIndex=0 ..."
//   切断:   "Unregistered tunnel connection connIndex=N" /
//           "Retrying connection in up to Ns connIndex=N" /
//           "failed to serve tunnel connection ... connIndex=N" /
//           "control stream encountered a failure ... connIndex=N"
// 登録済みの connIndex が 1 本以上あった後に 0 本になったら degraded、再び Registered が
// 来たら回復。プロセスは生きたまま再試行ループに入るため、close/exit では検知できない。

export interface ConnectionHealth {
  readonly degraded: boolean;
  readonly lastError?: string;
}

const CONN_INDEX = /connIndex=(\d+)/;
const REGISTERED = /Registered tunnel connection/;
const DROPPED =
  /Unregistered tunnel connection|Retrying connection|failed to serve tunnel connection|control stream encountered a failure/;
const MAX_LINE = 4096;

export interface ConnectionMonitor {
  feed(text: string): void;
  reset(): void;
}

export function createConnectionMonitor(
  onChange: (health: ConnectionHealth) => void,
): ConnectionMonitor {
  const registered = new Set<string>();
  let degraded = false;
  let pending = '';

  const handleLine = (line: string): void => {
    const index = CONN_INDEX.exec(line)?.[1];
    if (REGISTERED.test(line)) {
      registered.add(index ?? '?');
      if (degraded) {
        degraded = false;
        onChange({ degraded: false });
      }
      return;
    }
    if (!DROPPED.test(line)) {
      return;
    }
    if (index !== undefined) {
      registered.delete(index);
    } else {
      registered.clear();
    }
    if (registered.size === 0 && !degraded) {
      degraded = true;
      onChange({ degraded: true, lastError: line.trim().slice(0, 300) });
    }
  };

  return {
    feed(text) {
      pending += text;
      const lines = pending.split('\n');
      pending = (lines.pop() ?? '').slice(-MAX_LINE);
      for (const line of lines) {
        handleLine(line);
      }
    },
    reset() {
      registered.clear();
      degraded = false;
      pending = '';
    },
  };
}
