function hasForbiddenChar(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || raw.charAt(i) === '\\') {
      return true;
    }
  }
  return false;
}

/**
 * 根からの相対パスを 1 つだけ末尾スラッシュを落として返す。
 * 閉じ込めに使えない形は undefined。非 ASCII（日本語など）は残す。
 */
export function normalizeLocalRelativePath(raw: string): string | undefined {
  if (hasForbiddenChar(raw) || raw.startsWith('/') || raw.startsWith('~')) {
    return undefined;
  }
  const normalized = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (normalized.length === 0) {
    return undefined;
  }
  for (const segment of normalized.split('/')) {
    if (segment.length === 0 || segment === '..' || segment.startsWith('.')) {
      return undefined;
    }
  }
  return normalized;
}
