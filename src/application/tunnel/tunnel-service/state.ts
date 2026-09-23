import type { TunnelState } from './types.js';

/**
 * bdboard-ksvs: createTunnelService() が内部クロージャ (start/stop/shutdown/
 * startInternal/stopInternal/probeAvailability/setAvailability) 間で素朴な `let`
 * 変数として共有していた可変状態を、1つの明示的なコンテナへまとめたもの。
 *
 * 各フィールドの意味は分割前 (bdboard-sso1.64 PR #626) と同一で、挙動は変えていない:
 * - state: 公開される TunnelState そのもの。
 * - writeAllowed: 起動時のパスワード強度から決まる書き込み開放フラグ。state と別に
 *   持つのは、TunnelState が UI へそのまま渡る DTO の元になっており、判定材料
 *   (パスワード種別) をそこに載せたくないため。stop / 異常終了 / start 失敗の
 *   いずれでも false へ戻す。
 * - availability: 可用性 probe の結果キャッシュ。「使える」は恒久、「使えない」は
 *   TUNNEL_AVAILABILITY_RECHECK_MS の TTL 付き (bdboard-syr)。
 * - operationGeneration: start/stop が同時に来たとき、古い操作の完了結果で state を
 *   上書きしないための世代。start/stop/shutdown の先頭で加算し、各操作は開始時に
 *   captured して完了時に照合する。
 * - startInFlight / stopInFlight: 実行中の start()/stop() を重複起動させないための
 *   in-flight Promise。
 *
 * このオブジェクトは createTunnelService() の呼び出しごとに1つ作られ、以後は
 * ./availability.ts と ./start-stop.ts の各関数へ参照渡しされて共有・変異される
 * (モジュールを跨いでも同じインスタンスを指すので、可変状態の共有という分割前の
 * クロージャと同じ意味論を保つ)。
 */
export interface TunnelServiceState {
  state: TunnelState;
  writeAllowed: boolean;
  availability: { readonly value: boolean; readonly at: number } | null;
  operationGeneration: number;
  startInFlight: Promise<TunnelState> | null;
  stopInFlight: Promise<TunnelState> | null;
}

export function createTunnelServiceState(): TunnelServiceState {
  return {
    state: { kind: 'off' },
    writeAllowed: false,
    availability: null,
    operationGeneration: 0,
    startInFlight: null,
    stopInFlight: null,
  };
}
