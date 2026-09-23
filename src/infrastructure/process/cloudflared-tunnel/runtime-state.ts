// bdboard-sso1.57: createCloudflaredTunnel() の1回の呼び出しにつき1つ生成される、可変
// 実行時状態。以前は createCloudflaredTunnel() 本体のクロージャ変数 (child / outputBuffer /
// unexpectedExitListeners) として持っていたものを、spawn・出力監視・kill の各関心へ渡せる
// ように明示的なオブジェクトへまとめた。オブジェクト参照を共有して直接書き換える点は、元の
// クロージャ変数を複数の内部関数から書き換えていたのと同じ意味論(挙動は変えていない)。
import type { SpawnedProcess } from './spawned-process.js';

export interface TunnelRuntimeState {
  /** 現在追跡している子プロセス。stop() 完了後や、URL 未検出のまま終了した後は null。 */
  child: SpawnedProcess | null;
  /** URL 検出待ち中に蓄積する stdout/stderr の内容。URL 検出後・停止後にクリアする。 */
  outputBuffer: string;
  /** onUnexpectedExit() で登録されたリスナー。 */
  readonly unexpectedExitListeners: Array<() => void>;
}

export function createTunnelRuntimeState(): TunnelRuntimeState {
  return {
    child: null,
    outputBuffer: '',
    unexpectedExitListeners: [],
  };
}

export function notifyUnexpectedExit(state: TunnelRuntimeState): void {
  for (const listener of state.unexpectedExitListeners) {
    listener();
  }
}
