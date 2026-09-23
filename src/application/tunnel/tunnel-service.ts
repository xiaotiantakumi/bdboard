// bdboard-sso1.64: src/application/tunnel/tunnel-service.ts は
// bdboard-sso1.64 でモジュール分割された。実体は ./tunnel-service/ 配下:
//   - types.ts               : 公開型 (TunnelState / TunnelServiceDeps / TunnelService)
//   - availability-recheck.ts: 可用性再probeの間隔定数 (TUNNEL_AVAILABILITY_RECHECK_MS)
//   - error-message.ts       : unknown な catch 値をメッセージ文字列へ変換するヘルパー
//   - state.ts               : 可変状態 (state/writeAllowed/availability/
//     operationGeneration/startInFlight/stopInFlight) を1つにまとめた明示的な
//     コンテナ TunnelServiceState (bdboard-ksvs)。
//   - availability.ts        : setAvailability/probeAvailability (bdboard-ksvs)
//   - start-stop.ts          : start/stop/shutdown/startInternal/stopInternal
//     (bdboard-ksvs)
// bdboard-sso1.64 の時点では、これらの関数群が state 等の可変状態を素朴な `let`
// としてクロージャ経由で直接共有しており、それ以上の分割には状態を外へ持ち出す
// 構造変更が要る、という理由で createTunnelService() 本体をこのファイルに残した。
// bdboard-ksvs で可変状態を TunnelServiceState という明示的なコンテナへまとめ、
// 各関数へ引数として渡す形にしたことで、start/stop 系 (./start-stop.ts) と
// probe/availability 系 (./availability.ts) を別モジュールへ切り出せるようになった。
// 挙動は変えていない (in-flight の重複排除・operationGeneration による古い操作の
// 破棄・shutdown 中の中断記録などの順序と競合時の挙動は同一。テストは
// tunnel-service.test.ts に加え、状態遷移そのものを検証する
// tunnel-service/start-stop.test.ts / tunnel-service/availability.test.ts を追加)。
import { probeAvailability } from './tunnel-service/availability.js';
import { shutdown, start, stop } from './tunnel-service/start-stop.js';
import { createTunnelServiceState } from './tunnel-service/state.js';
import type { TunnelService, TunnelServiceDeps } from './tunnel-service/types.js';

export type { TunnelState, TunnelServiceDeps, TunnelService } from './tunnel-service/types.js';
export { TUNNEL_AVAILABILITY_RECHECK_MS } from './tunnel-service/availability-recheck.js';

export function createTunnelService(deps: TunnelServiceDeps): TunnelService {
  const ctx = createTunnelServiceState();

  // 開発サーバー本体の再起動等でcloudflared子プロセスが道連れに終了した場合、
  // "off"のまま(ユーザーが能動的に止めたのか区別つかない)にせず、error状態にして
  // UIに気づけるメッセージを出す。ユーザーがstop()を呼んだ場合はこのリスナーは
  // 発火しない(tunnel.stop()の実装が保証する)。
  deps.tunnel.onUnexpectedExit?.(() => {
    if (ctx.state.kind === 'on') {
      deps.access?.endTunnelSession();
      ctx.writeAllowed = false;
      ctx.state = {
        kind: 'error',
        message:
          '開発サーバーの再起動によりトンネルが切断されました。再度ONにしてください。',
      };
    }
  });

  const getAvailability = (): boolean => ctx.availability?.value === true;

  const isWriteAllowed = (): boolean => ctx.state.kind === 'on' && ctx.writeAllowed;

  const getCredentials = (): { readonly username: string; readonly password: string } | null => {
    if (ctx.state.kind !== 'on') {
      return null;
    }
    return { username: ctx.state.username, password: ctx.state.password };
  };

  const getInterruptedAt = (): Date | null => deps.interruptions?.read() ?? null;

  const dismissInterruption = (): void => {
    deps.interruptions?.clear();
  };

  return {
    start: (options) => start(ctx, deps, options),
    stop: () => stop(ctx, deps),
    shutdown: () => shutdown(ctx, deps),
    getState: () => ctx.state,
    getCredentials,
    isWriteAllowed,
    getAvailability,
    probeAvailability: () => probeAvailability(ctx, deps),
    getInterruptedAt,
    dismissInterruption,
  };
}
