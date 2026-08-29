import type { TunnelInterruptionStore } from '../ports/tunnel-interruption-store.js';
import type { TunnelProcess } from '../ports/tunnel.js';
import type { TunnelAccessService } from './tunnel-access.js';
import {
  passwordAllowsTunnelWrites,
  type TunnelPasswordSource,
} from './tunnel-write-policy.js';

export type TunnelState =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'off' }
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'on';
      readonly url: string;
      readonly username: string;
      readonly password: string;
      readonly startedAt: Date;
    }
  | { readonly kind: 'error'; readonly message: string };

/**
 * cloudflared が「使えない」と判定されたあと、再度 probe するまでの間隔。
 * 未インストールは後から解消しうるので恒久キャッシュにはできず、かといって
 * 毎リクエスト PATH を舐めるのも無駄なので TTL で妥協する (bdboard-syr)。
 */
export const TUNNEL_AVAILABILITY_RECHECK_MS = 30_000;

export interface TunnelServiceDeps {
  readonly tunnel: TunnelProcess;
  readonly now: () => Date;
  readonly username: string;
  readonly generatePassword: () => string;
  readonly access?: TunnelAccessService;
  readonly interruptions?: TunnelInterruptionStore;
}

export interface TunnelService {
  start(options?: { readonly password?: string }): Promise<TunnelState>;
  stop(): Promise<TunnelState>;
  /** サーバー停止時の後始末。稼働中なら中断記録を残してから off へ遷移する (bdboard-8v8)。 */
  shutdown(): Promise<TunnelState>;
  getState(): TunnelState;
  getCredentials(): { readonly username: string; readonly password: string } | null;
  /** 現在のトンネルがトンネル経由の書き込みを開放してよい資格情報で動いているか。
   *  トンネルが on でなければ常に false(bdboard-9rz)。 */
  isWriteAllowed(): boolean;
  getAvailability(): boolean;
  probeAvailability(): Promise<boolean>;
  getInterruptedAt(): Date | null;
  dismissInterruption(): void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function createTunnelService(deps: TunnelServiceDeps): TunnelService {
  let state: TunnelState = { kind: 'off' };
  // 起動時のパスワード強度から決まる書き込み開放フラグ。state と別に持つのは、
  // TunnelState が UI へそのまま渡る DTO の元になっており、判定材料(パスワード種別)を
  // そこに載せたくないため。stop / 異常終了 / start 失敗のいずれでも false へ戻す。
  let writeAllowed = false;
  let availability: { readonly value: boolean; readonly at: number } | null = null;
  // start/stop が同時に来たとき、古い操作の完了結果で state を上書きしないための世代。
  // start/stop/shutdown の先頭で加算し、各操作は開始時に captured して完了時に照合する。
  let operationGeneration = 0;
  let startInFlight: Promise<TunnelState> | null = null;
  let stopInFlight: Promise<TunnelState> | null = null;

  // 開発サーバー本体の再起動等でcloudflared子プロセスが道連れに終了した場合、
  // "off"のまま(ユーザーが能動的に止めたのか区別つかない)にせず、error状態にして
  // UIに気づけるメッセージを出す。ユーザーがstop()を呼んだ場合はこのリスナーは
  // 発火しない(tunnel.stop()の実装が保証する)。
  deps.tunnel.onUnexpectedExit?.(() => {
    if (state.kind === 'on') {
      deps.access?.endTunnelSession();
      writeAllowed = false;
      state = {
        kind: 'error',
        message:
          '開発サーバーの再起動によりトンネルが切断されました。再度ONにしてください。',
      };
    }
  });

  const setAvailability = (value: boolean): void => {
    availability = { value, at: deps.now().getTime() };
    if (!value && state.kind !== 'unavailable') {
      state = { kind: 'unavailable' };
      return;
    }
    // 後から cloudflared が入った場合。unavailable に落としたままだと UI からは
    // 永久に使えないままに見えるので、通常の初期状態へ戻す (bdboard-syr)。
    if (value && state.kind === 'unavailable') {
      state = { kind: 'off' };
    }
  };

  const probeAvailability = async (): Promise<boolean> => {
    if (availability !== null) {
      // 「使える」は覆らないので恒久キャッシュでよい。「使えない」は brew install
      // 一つで覆るので、TTL を過ぎたら probe し直す。ここを固定していたせいで、
      // 後から入れた cloudflared がサーバー再起動まで見えなかった (bdboard-syr)。
      if (availability.value) {
        return true;
      }
      if (deps.now().getTime() - availability.at < TUNNEL_AVAILABILITY_RECHECK_MS) {
        return false;
      }
    }

    try {
      const available = await deps.tunnel.isAvailable();
      setAvailability(available);
      return available;
    } catch {
      setAvailability(false);
      return false;
    }
  };

  const getAvailability = (): boolean => availability?.value === true;

  const isWriteAllowed = (): boolean => state.kind === 'on' && writeAllowed;

  const getCredentials = (): { readonly username: string; readonly password: string } | null => {
    if (state.kind !== 'on') {
      return null;
    }
    return { username: state.username, password: state.password };
  };

  const stopInternal = async (
    capturedGeneration?: number,
  ): Promise<TunnelState> => {
    if (state.kind === 'unavailable') {
      return state;
    }

    try {
      await deps.tunnel.stop();
    } catch {
      // stop failures are non-fatal for state transition
    }

    if (
      capturedGeneration !== undefined &&
      capturedGeneration !== operationGeneration
    ) {
      return state;
    }

    deps.access?.endTunnelSession();
    writeAllowed = false;
    state = { kind: 'off' };
    return state;
  };

  const stop = async (): Promise<TunnelState> => {
    if (stopInFlight !== null) {
      return stopInFlight;
    }

    operationGeneration += 1;
    const capturedGeneration = operationGeneration;

    stopInFlight = (async (): Promise<TunnelState> => {
      deps.interruptions?.clear();
      return stopInternal(capturedGeneration);
    })().finally(() => {
      stopInFlight = null;
    });

    return stopInFlight;
  };

  const shutdown = async (): Promise<TunnelState> => {
    if (stopInFlight !== null) {
      return stopInFlight;
    }

    operationGeneration += 1;
    const capturedGeneration = operationGeneration;

    stopInFlight = (async (): Promise<TunnelState> => {
      if (state.kind === 'on') {
        deps.interruptions?.markInterrupted(deps.now());
      }
      return stopInternal(capturedGeneration);
    })().finally(() => {
      stopInFlight = null;
    });

    return stopInFlight;
  };

  const startInternal = async (
    options: { readonly password?: string } | undefined,
    capturedGeneration: number,
  ): Promise<TunnelState> => {
    const available = await probeAvailability();
    if (!available) {
      state = { kind: 'unavailable' };
      return state;
    }

    if (capturedGeneration !== operationGeneration) {
      return state;
    }

    if (state.kind === 'on') {
      // 再起動時の stop は世代を進めない。stop() 経由だと自分の start を無効化してしまう。
      deps.interruptions?.clear();
      await stopInternal();
    }

    if (capturedGeneration !== operationGeneration) {
      return state;
    }

    const passwordSource: TunnelPasswordSource =
      options?.password !== undefined ? 'user-supplied' : 'generated';
    const password = options?.password ?? deps.generatePassword();
    writeAllowed = passwordAllowsTunnelWrites(passwordSource, password);
    state = { kind: 'starting' };

    try {
      const result = await deps.tunnel.start();
      if (capturedGeneration !== operationGeneration) {
        try {
          await deps.tunnel.stop();
        } catch {
          // ignore cleanup failures
        }
        return state;
      }

      const startedAt = deps.now();
      state = {
        kind: 'on',
        url: result.url,
        username: deps.username,
        password,
        startedAt,
      };
      deps.interruptions?.clear();
      deps.access?.beginTunnelSession();
      return state;
    } catch (err) {
      try {
        await deps.tunnel.stop();
      } catch {
        // ignore cleanup failures
      }

      deps.access?.endTunnelSession();
      writeAllowed = false;
      if (capturedGeneration !== operationGeneration) {
        return state;
      }

      const message = errorMessage(err);
      state = { kind: 'error', message };
      return state;
    }
  };

  const start = async (
    options?: { readonly password?: string },
  ): Promise<TunnelState> => {
    if (startInFlight !== null) {
      return startInFlight;
    }

    operationGeneration += 1;
    const capturedGeneration = operationGeneration;

    startInFlight = (async (): Promise<TunnelState> => {
      if (stopInFlight !== null) {
        await stopInFlight;
      }
      return startInternal(options, capturedGeneration);
    })().finally(() => {
      startInFlight = null;
    });

    return startInFlight;
  };

  const getInterruptedAt = (): Date | null => deps.interruptions?.read() ?? null;

  const dismissInterruption = (): void => {
    deps.interruptions?.clear();
  };

  return {
    start,
    stop,
    shutdown,
    getState: () => state,
    getCredentials,
    isWriteAllowed,
    getAvailability,
    probeAvailability,
    getInterruptedAt,
    dismissInterruption,
  };
}
