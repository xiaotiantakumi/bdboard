import { fetchJson } from './http';

export type TunnelStateKind =
  | 'off'
  | 'starting'
  | 'on'
  | 'error'
  | 'unavailable';

export interface TunnelDtoBase {
  state: TunnelStateKind;
  available: boolean;
  /** Site-wide Basic Auth is active, so starting a public tunnel is safe. */
  authEnabled: boolean;
  /** 前回サーバー停止時にトンネルが稼働していた場合の停止時刻 (bdboard-8v8)。
   *  サーバーは state==='on' のときは返さない。資格情報は含まれない。 */
  interruptedAt?: string;
}

export interface TunnelDtoOn extends TunnelDtoBase {
  state: 'on';
  url: string;
  startedAt: string;
  /** トンネル経由の書き込みが開いているか(bdboard-9rz)。短いパスワードで起動した
   *  トンネルは読み取り専用になるので、UI 側で理由を説明するのに使える。 */
  writeAccess?: boolean;
}

export interface TunnelDtoError extends TunnelDtoBase {
  state: 'error';
  message: string;
}

export type TunnelDto =
  | (TunnelDtoBase & { state: 'off' })
  | (TunnelDtoBase & { state: 'starting' })
  | TunnelDtoOn
  | TunnelDtoError
  | (TunnelDtoBase & { state: 'unavailable' });

export function fetchTunnel(): Promise<TunnelDto> {
  return fetchJson<TunnelDto>('/api/tunnel');
}

export function startTunnel(password?: string): Promise<TunnelDto> {
  const body =
    password !== undefined && password.length > 0 ? { password } : {};
  return fetchJson<TunnelDto>('/api/tunnel/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function stopTunnel(): Promise<TunnelDto> {
  return fetchJson<TunnelDto>('/api/tunnel/stop', {
    method: 'POST',
  });
}

export function dismissTunnelInterruption(): Promise<TunnelDto> {
  return fetchJson<TunnelDto>('/api/tunnel/interruption/dismiss', {
    method: 'POST',
  });
}

export interface TunnelAccessTokenDto {
  token: string;
  expiresAt: string;
}

export function createTunnelAccessToken(): Promise<TunnelAccessTokenDto> {
  return fetchJson<TunnelAccessTokenDto>('/api/tunnel/access-token', {
    method: 'POST',
  });
}
