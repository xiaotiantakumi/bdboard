import { createHash } from 'node:crypto';

const ETAG_HASH_HEX_LENGTH = 32;

/** SHA-256 over the bytes, truncated hex (32 chars). The building block of every ETag in this file. */
export function etagDigestOf(input: string | Buffer): string {
  return createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, ETAG_HASH_HEX_LENGTH);
}

/** SHA-256 over uncompressed bytes, truncated hex, formatted as a weak ETag. */
export function computeWeakEtag(input: string | Buffer): string {
  return `W/"${etagDigestOf(input)}"`;
}

/**
 * Same digest as computeWeakEtag, formatted as a strong ETag (`"<hex>"`). For resources
 * a client sends back in If-Match (issue report drafts, bdboard-mqoa). hono/compress
 * rewrites it to W/"…" on a gzip'd response; ifMatchAccepts tolerates that.
 */
export function computeStrongEtag(input: string | Buffer): string {
  return `"${etagDigestOf(input)}"`;
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

/** Entries of an If-Match / If-None-Match list: trimmed, empty ones dropped (a blank value or `,,` gives none). */
function etagListEntries(headerValue: string): string[] {
  return headerValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Compare If-None-Match against our ETag. Handles lists, whitespace, W/ prefix, and *.
 */
export function ifNoneMatchMatches(
  ifNoneMatch: string,
  etag: string,
): boolean {
  if (ifNoneMatch.trim() === '*') {
    return true;
  }
  const normalizedEtag = normalizeEtagToken(etag);
  return etagListEntries(ifNoneMatch).some((candidate) => normalizeEtagToken(candidate) === normalizedEtag);
}

/**
 * Judge If-Match against a resource that exists (the caller answers 404 first when it does
 * not): `*` matches; a list matches when `accepts` takes any entry. `accepts` gets the entry
 * with the W/ prefix and the quotes stripped (normalizeEtagToken), so a caller that compares
 * only a part of its ETag (issue report drafts compare the edit digest, bdboard-q5pj) keeps
 * the same `*`, list, W/, empty and garbage rules as a whole-ETag comparison.
 *
 * RFC 9110 asks for strong comparison, but this server's own gzip middleware (hono/compress)
 * turns a strong ETag into W/"…" on a compressed response, a tunnel may do the same, and a
 * client sends back whatever it received. Rejecting every such request would make If-Match
 * unusable, so the W/ prefix is ignored: the digests are compared (same as ifNoneMatchMatches).
 */
export function ifMatchAccepts(ifMatch: string, accepts: (normalizedToken: string) => boolean): boolean {
  if (ifMatch.trim() === '*') {
    return true;
  }
  return etagListEntries(ifMatch).some((candidate) => accepts(normalizeEtagToken(candidate)));
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
