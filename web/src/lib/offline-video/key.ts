const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * ticketId と path から安定したファイル名キーを作る (FNV-1a 32bit を 8 桁の16進)。
 * 区切りに NUL を挟むので、ticketId と path の境界がずれても同じキーにならない。
 * 暗号学的な衝突耐性は要らない。OPFS のファイル名は呼び出し側が `${key}.mp4` にする。
 */
export function offlineVideoKey(ticketId: string, path: string): string {
  const bytes = new TextEncoder().encode(`${ticketId}\0${path}`);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
