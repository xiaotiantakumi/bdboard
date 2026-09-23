import { createHash, timingSafeEqual } from 'node:crypto';
import type { BasicAuthConfig } from './types.js';

const DUMMY_AUTH_CONFIG: BasicAuthConfig = {
  username: '\u0000',
  password: '\u0000',
};

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a, 'utf8').digest();
  const hashB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(hashA, hashB);
}

export function parseBasicAuth(
  header: string,
): { readonly username: string; readonly password: string } | null {
  // RFC 7235: the auth-scheme token is case-insensitive.
  if (!/^basic\s/i.test(header)) {
    return null;
  }

  const encoded = header.replace(/^basic\s+/i, '').trim();
  if (encoded.length === 0) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, colonIndex),
      password: decoded.slice(colonIndex + 1),
    };
  } catch {
    return null;
  }
}

function validateCredentials(
  provided: { readonly username: string; readonly password: string },
  config: BasicAuthConfig,
): boolean {
  const usernameMatch = constantTimeEqual(provided.username, config.username);
  const passwordMatch = constantTimeEqual(provided.password, config.password);
  return usernameMatch && passwordMatch;
}

export function validateAgainstPrimaryAndExtra(
  provided: { readonly username: string; readonly password: string },
  primary: BasicAuthConfig,
  extra: BasicAuthConfig | null,
): boolean {
  // 環境変数由来とトンネル発行の資格情報を常に両方比較してから OR を取る。
  // どちらか一方で早期 return すると、一致した側がタイミングから推測される。
  const primaryMatch = validateCredentials(provided, primary);
  const extraTarget = extra ?? DUMMY_AUTH_CONFIG;
  const extraMatch = validateCredentials(provided, extraTarget);
  return primaryMatch || extraMatch;
}
