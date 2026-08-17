import { createHash } from 'node:crypto';

const ETAG_HASH_HEX_LENGTH = 32;

/** SHA-256 over uncompressed bytes, truncated hex, formatted as a weak ETag. */
export function computeWeakEtag(input: string | Buffer): string {
  const hash = createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, ETAG_HASH_HEX_LENGTH);
  return `W/"${hash}"`;
}

/** Strip weak prefix and surrounding quotes so validators compare by digest alone. */
export function normalizeEtagToken(raw: string): string {
  let token = raw.trim();
  if (/^W\s*\//i.test(token)) {
    token = token.replace(/^W\s*\//i, '').trim();
  }
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    token = token.slice(1, -1);
  }
  return token;
}

/**
 * Compare If-None-Match against our ETag. Handles lists, whitespace, W/ prefix, and *.
 */
export function ifNoneMatchMatches(
  ifNoneMatch: string,
  etag: string,
): boolean {
  const trimmed = ifNoneMatch.trim();
  if (trimmed === '*') {
    return true;
  }

  const normalizedEtag = normalizeEtagToken(etag);
  const candidates = trimmed.split(',').map((part) => part.trim());

  for (const candidate of candidates) {
    if (candidate.length === 0) {
      continue;
    }
    if (normalizeEtagToken(candidate) === normalizedEtag) {
      return true;
    }
  }

  return false;
}

/**
 * Board JSON for ETag hashing: `generatedAt` changes every poll via deps.now() but
 * is not part of the board snapshot clients reconcile on, so exclude it here.
 */
export function boardViewDtoStableJson<
  T extends Readonly<{ generatedAt: string }>,
>(dto: T): string {
  const { generatedAt: _ignored, ...stable } = dto;
  return JSON.stringify(stable);
}
