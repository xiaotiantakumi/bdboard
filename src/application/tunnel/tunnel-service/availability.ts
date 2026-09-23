import { TUNNEL_AVAILABILITY_RECHECK_MS } from './availability-recheck.js';
import type { TunnelServiceState } from './state.js';
import type { TunnelServiceDeps } from './types.js';

/**
 * bdboard-ksvs: createTunnelService() から切り出した可用性まわり
 * (setAvailability/probeAvailability)。分割前 (bdboard-sso1.64) のクロージャ本体を
 * そのまま、共有していた `let` 変数を `ctx: TunnelServiceState` 経由の読み書きに
 * 置き換えただけで、判定条件・順序・エラー処理は変えていない。
 */
export function setAvailability(
  ctx: TunnelServiceState,
  deps: TunnelServiceDeps,
  value: boolean,
): void {
  ctx.availability = { value, at: deps.now().getTime() };
  if (!value && ctx.state.kind !== 'unavailable') {
    ctx.state = { kind: 'unavailable' };
    return;
  }
  // 後から cloudflared が入った場合。unavailable に落としたままだと UI からは
  // 永久に使えないままに見えるので、通常の初期状態へ戻す (bdboard-syr)。
  if (value && ctx.state.kind === 'unavailable') {
    ctx.state = { kind: 'off' };
  }
}

export async function probeAvailability(
  ctx: TunnelServiceState,
  deps: TunnelServiceDeps,
): Promise<boolean> {
  if (ctx.availability !== null) {
    // 「使える」は覆らないので恒久キャッシュでよい。「使えない」は brew install
    // 一つで覆るので、TTL を過ぎたら probe し直す。ここを固定していたせいで、
    // 後から入れた cloudflared がサーバー再起動まで見えなかった (bdboard-syr)。
    if (ctx.availability.value) {
      return true;
    }
    if (deps.now().getTime() - ctx.availability.at < TUNNEL_AVAILABILITY_RECHECK_MS) {
      return false;
    }
  }

  try {
    const available = await deps.tunnel.isAvailable();
    setAvailability(ctx, deps, available);
    return available;
  } catch {
    setAvailability(ctx, deps, false);
    return false;
  }
}
