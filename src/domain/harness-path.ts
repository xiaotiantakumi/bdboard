import path from 'node:path';

export const CLAUDE_DIR = '.claude';
export const MANIFEST_RELATIVE_PATH = '.claude/bdboard-packs.json';
export const SKILLS_DIR = '.claude/skills';

const PACK_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isSafePackName(name: string): boolean {
  return PACK_NAME_PATTERN.test(name);
}

export function toPosixRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

/** プロジェクトルートからの相対パスを正規化する。脱出や絶対パスは null。 */
export function normalizeProjectRelativePath(relativePath: string): string | null {
  const posix = toPosixRelative(relativePath);
  if (posix.length === 0) {
    return null;
  }
  if (path.posix.isAbsolute(posix)) {
    return null;
  }
  // 正規化「前」に検査する: `.claude/../secret` は normalize で `secret` になり
  // `..` の痕跡が消えるため、正規化後の検査では素通りする
  if (posix.split('/').includes('..')) {
    return null;
  }

  return path.posix.normalize(posix);
}

export function isUnderClaudeDir(projectRelativePath: string): boolean {
  const normalized = normalizeProjectRelativePath(projectRelativePath);
  if (normalized === null) {
    return false;
  }

  return normalized === CLAUDE_DIR || normalized.startsWith(`${CLAUDE_DIR}/`);
}

export function skillInstallRelativePath(
  packName: string,
  packFileRelative: string,
): string | null {
  if (!isSafePackName(packName)) {
    return null;
  }

  const filePart = normalizeProjectRelativePath(packFileRelative);
  if (filePart === null) {
    return null;
  }

  return normalizeProjectRelativePath(path.posix.join(SKILLS_DIR, packName, filePart));
}

/**
 * projectRoot と projectRelativePath から絶対パスを解決する。
 * .claude/ 配下に収まらない場合は null (パストラバーサル拒否)。
 */
export function resolveUnderClaudeDir(
  projectRoot: string,
  projectRelativePath: string,
): string | null {
  const normalized = normalizeProjectRelativePath(projectRelativePath);
  if (normalized === null || !isUnderClaudeDir(normalized)) {
    return null;
  }

  const absolute = path.resolve(projectRoot, normalized);
  const claudeRoot = path.resolve(projectRoot, CLAUDE_DIR);
  const relativeToClaude = path.relative(claudeRoot, absolute);
  if (relativeToClaude.startsWith('..') || path.isAbsolute(relativeToClaude)) {
    return null;
  }

  return absolute;
}
