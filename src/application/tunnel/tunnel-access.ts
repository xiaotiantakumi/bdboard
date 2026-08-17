import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface TunnelAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface TunnelAccessService {
  /** トンネルセッション開始。既存のトークン/セッションは全て失効させる */
  beginTunnelSession(): void;
  /** トンネルセッション終了。全トークン・全 Cookie セッションを失効させる */
  endTunnelSession(): void;
  /** 現在のトンネルセッションに紐づく単回使用トークンを発行する。
   *  トンネルセッションが無ければ null */
  issueToken(): TunnelAccessToken | null;
  /** トークンを消費して Cookie に載せるセッション ID を返す。
   *  失敗 (不正/期限切れ/使用済み/別トンネルセッション) なら null */
  consumeToken(token: string): { readonly sessionId: string; readonly expiresAt: Date } | null;
  /** Cookie のセッション ID が現在のトンネルセッションで有効か */
  isValidSession(sessionId: string): boolean;
}

export interface TunnelAccessDeps {
  readonly now: () => Date;
  /** テスト用に差し替え可能。既定は randomBytes(32).toString('base64url') */
  readonly generateSecret?: () => string;
  /** 既定 5 * 60_000 (5分) */
  readonly tokenTtlMs?: number;
  /** Cookie セッションの寿命。既定 12 * 60 * 60_000 (12時間)。
   *  これとは別にトンネル停止で即失効する */
  readonly sessionTtlMs?: number;
}

const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_TOKENS = 32;

interface TokenEntry {
  readonly digest: Buffer;
  readonly epoch: number;
  readonly expiresAt: number;
  consumed: boolean;
  readonly issuedAt: number;
}

interface SessionEntry {
  readonly digest: Buffer;
  readonly epoch: number;
  readonly expiresAt: number;
}

function digestOf(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function defaultGenerateSecret(): string {
  return randomBytes(32).toString('base64url');
}

function digestsMatch(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function createTunnelAccessService(deps: TunnelAccessDeps): TunnelAccessService {
  const now = deps.now;
  const generateSecret = deps.generateSecret ?? defaultGenerateSecret;
  const tokenTtlMs = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  let currentEpoch: number | null = null;
  let nextEpoch = 0;
  const tokens: TokenEntry[] = [];
  const sessions: SessionEntry[] = [];

  const cleanupExpired = (): void => {
    const currentTime = now().getTime();
    for (let i = tokens.length - 1; i >= 0; i -= 1) {
      if (tokens[i].expiresAt <= currentTime) {
        tokens.splice(i, 1);
      }
    }
    for (let i = sessions.length - 1; i >= 0; i -= 1) {
      if (sessions[i].expiresAt <= currentTime) {
        sessions.splice(i, 1);
      }
    }
  };

  const pruneOldTokens = (): void => {
    if (tokens.length <= MAX_TOKENS) {
      return;
    }
    tokens.sort((a, b) => a.issuedAt - b.issuedAt);
    tokens.splice(0, tokens.length - MAX_TOKENS);
  };

  const beginTunnelSession = (): void => {
    nextEpoch += 1;
    currentEpoch = nextEpoch;
    tokens.length = 0;
    sessions.length = 0;
  };

  const endTunnelSession = (): void => {
    currentEpoch = null;
    tokens.length = 0;
    sessions.length = 0;
  };

  const issueToken = (): TunnelAccessToken | null => {
    if (currentEpoch === null) {
      return null;
    }

    cleanupExpired();
    pruneOldTokens();

    const token = generateSecret();
    const expiresAt = new Date(now().getTime() + tokenTtlMs);
    tokens.push({
      digest: digestOf(token),
      epoch: currentEpoch,
      expiresAt: expiresAt.getTime(),
      consumed: false,
      issuedAt: now().getTime(),
    });

    return { token, expiresAt };
  };

  const consumeToken = (
    token: string,
  ): { readonly sessionId: string; readonly expiresAt: Date } | null => {
    if (currentEpoch === null) {
      return null;
    }

    cleanupExpired();

    const tokenDigest = digestOf(token);
    const currentTime = now().getTime();
    let matchedEntry: TokenEntry | null = null;

    for (const entry of tokens) {
      const isMatch = digestsMatch(tokenDigest, entry.digest);
      if (isMatch) {
        matchedEntry = entry;
      }
    }

    if (
      matchedEntry === null ||
      matchedEntry.consumed ||
      matchedEntry.epoch !== currentEpoch ||
      matchedEntry.expiresAt <= currentTime
    ) {
      return null;
    }

    matchedEntry.consumed = true;

    const sessionId = generateSecret();
    const expiresAt = new Date(now().getTime() + sessionTtlMs);
    sessions.push({
      digest: digestOf(sessionId),
      epoch: currentEpoch,
      expiresAt: expiresAt.getTime(),
    });

    return { sessionId, expiresAt };
  };

  const isValidSession = (sessionId: string): boolean => {
    if (currentEpoch === null) {
      return false;
    }

    cleanupExpired();

    const sessionDigest = digestOf(sessionId);
    const currentTime = now().getTime();
    let valid = false;

    for (const entry of sessions) {
      if (entry.epoch !== currentEpoch || entry.expiresAt <= currentTime) {
        continue;
      }
      if (digestsMatch(sessionDigest, entry.digest)) {
        valid = true;
      }
    }

    return valid;
  };

  return {
    beginTunnelSession,
    endTunnelSession,
    issueToken,
    consumeToken,
    isValidSession,
  };
}
