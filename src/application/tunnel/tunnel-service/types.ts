import type { TunnelInterruptionStore } from '../../ports/tunnel-interruption-store.js';
import type { TunnelProcess } from '../../ports/tunnel.js';
import type { TunnelAccessService } from '../tunnel-access.js';

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
