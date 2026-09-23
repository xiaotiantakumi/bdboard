import { passwordAllowsTunnelWrites, type TunnelPasswordSource } from '../tunnel-write-policy.js';
import { probeAvailability } from './availability.js';
import { errorMessage } from './error-message.js';
import type { TunnelServiceState } from './state.js';
import type { TunnelServiceDeps, TunnelState } from './types.js';

/**
 * bdboard-ksvs: createTunnelService() から切り出した start/stop/shutdown まわり。
 * 分割前 (bdboard-sso1.64) のクロージャ本体をそのまま、共有していた `let` 変数を
 * `ctx: TunnelServiceState` 経由の読み書きに置き換えただけで、in-flight の重複排除、
 * operationGeneration による古い操作の破棄、shutdown 中断記録の順序は変えていない。
 */
export async function stopInternal(
  ctx: TunnelServiceState,
  deps: TunnelServiceDeps,
  capturedGeneration?: number,
): Promise<TunnelState> {
  if (ctx.state.kind === 'unavailable') {
    return ctx.state;
  }

  try {
    await deps.tunnel.stop();
  } catch {
    // stop failures are non-fatal for state transition
  }

  if (capturedGeneration !== undefined && capturedGeneration !== ctx.operationGeneration) {
    return ctx.state;
  }

  deps.access?.endTunnelSession();
  ctx.writeAllowed = false;
  ctx.state = { kind: 'off' };
  return ctx.state;
}

export async function stop(
  ctx: TunnelServiceState,
  deps: TunnelServiceDeps,
): Promise<TunnelState> {
  if (ctx.stopInFlight !== null) {
    return ctx.stopInFlight;
  }

  ctx.operationGeneration += 1;
  const capturedGeneration = ctx.operationGeneration;

  ctx.stopInFlight = (async (): Promise<TunnelState> => {
    deps.interruptions?.clear();
    return stopInternal(ctx, deps, capturedGeneration);
  })().finally(() => {
    ctx.stopInFlight = null;
  });

  return ctx.stopInFlight;
}

export async function shutdown(
  ctx: TunnelServiceState,
  deps: TunnelServiceDeps,
): Promise<TunnelState> {
  if (ctx.stopInFlight !== null) {
    return ctx.stopInFlight;
  }

  ctx.operationGeneration += 1;
  const capturedGeneration = ctx.operationGeneration;

  ctx.stopInFlight = (async (): Promise<TunnelState> => {
    if (ctx.state.kind === 'on') {
      deps.interruptions?.markInterrupted(deps.now());
    }
    return stopInternal(ctx, deps, capturedGeneration);
  })().finally(() => {
    ctx.stopInFlight = null;
  });

  return ctx.stopInFlight;
}

export async function startInternal(
  ctx: TunnelServiceState,
  deps: TunnelServiceDeps,
  options: { readonly password?: string } | undefined,
  capturedGeneration: number,
): Promise<TunnelState> {
  const available = await probeAvailability(ctx, deps);
  if (!available) {
    ctx.state = { kind: 'unavailable' };
    return ctx.state;
  }

  if (capturedGeneration !== ctx.operationGeneration) {
    return ctx.state;
  }

  if (ctx.state.kind === 'on') {
    // 再起動時の stop は世代を進めない。stop() 経由だと自分の start を無効化してしまう。
    deps.interruptions?.clear();
    await stopInternal(ctx, deps);
  }

  if (capturedGeneration !== ctx.operationGeneration) {
    return ctx.state;
  }

  const passwordSource: TunnelPasswordSource =
    options?.password !== undefined ? 'user-supplied' : 'generated';
  const password = options?.password ?? deps.generatePassword();
  ctx.writeAllowed = passwordAllowsTunnelWrites(passwordSource, password);
  ctx.state = { kind: 'starting' };

  try {
    const result = await deps.tunnel.start();
    if (capturedGeneration !== ctx.operationGeneration) {
      try {
        await deps.tunnel.stop();
      } catch {
        // ignore cleanup failures
      }
      return ctx.state;
    }

    const startedAt = deps.now();
    ctx.state = {
      kind: 'on',
      url: result.url,
      username: deps.username,
      password,
      startedAt,
    };
    deps.interruptions?.clear();
    deps.access?.beginTunnelSession();
    return ctx.state;
  } catch (err) {
    try {
      await deps.tunnel.stop();
    } catch {
      // ignore cleanup failures
    }

    deps.access?.endTunnelSession();
    ctx.writeAllowed = false;
    if (capturedGeneration !== ctx.operationGeneration) {
      return ctx.state;
    }

    const message = errorMessage(err);
    ctx.state = { kind: 'error', message };
    return ctx.state;
  }
}

export async function start(
  ctx: TunnelServiceState,
  deps: TunnelServiceDeps,
  options?: { readonly password?: string },
): Promise<TunnelState> {
  if (ctx.startInFlight !== null) {
    return ctx.startInFlight;
  }

  ctx.operationGeneration += 1;
  const capturedGeneration = ctx.operationGeneration;

  ctx.startInFlight = (async (): Promise<TunnelState> => {
    if (ctx.stopInFlight !== null) {
      await ctx.stopInFlight;
    }
    return startInternal(ctx, deps, options, capturedGeneration);
  })().finally(() => {
    ctx.startInFlight = null;
  });

  return ctx.startInFlight;
}
