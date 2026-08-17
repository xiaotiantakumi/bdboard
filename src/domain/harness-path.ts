import path from 'node:path';

export const CLAUDE_DIR = '.claude';
export const MANIFEST_RELATIVE_PATH = '.claude/bdboard-packs.json';
export const SKILLS_DIR = '.claude/skills';
export const GITIGNORE_FILENAME = '.gitignore';
export const GITIGNORE_MANAGED_HEADER =
  '# bdboard-harness: managed pack injections (do not edit lines below by hand)';

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

export function gitignoreManifestEntry(): string {
  return MANIFEST_RELATIVE_PATH;
}

/** `.gitignore` 用のパック別スキルディレクトリ行。unsafe な packName は null。 */
export function gitignorePackSkillDirEntry(packName: string): string | null {
  if (!isSafePackName(packName)) {
    return null;
  }

  return `${SKILLS_DIR}/${packName}/`;
}

function existingGitignoreLineSet(content: string): Set<string> {
  return new Set(
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** 既存 `.gitignore` にまだ無い bdboard-harness 管理行だけを返す (順序: ヘッダー → manifest → pack)。 */
export function gitignoreLinesToAppend(content: string, packName: string): string[] {
  const existing = existingGitignoreLineSet(content);
  const lines: string[] = [];

  if (!existing.has(GITIGNORE_MANAGED_HEADER.trim())) {
    lines.push(GITIGNORE_MANAGED_HEADER);
  }

  const manifestEntry = gitignoreManifestEntry();
  if (!existing.has(manifestEntry.trim())) {
    lines.push(manifestEntry);
  }

  const packEntry = gitignorePackSkillDirEntry(packName);
  if (packEntry !== null && !existing.has(packEntry.trim())) {
    lines.push(packEntry);
  }

  return lines;
}

/** 既存内容を壊さず末尾に必要な行だけ追記した `.gitignore` 全文を返す。 */
export function appendGitignoreEntries(content: string, packName: string): string {
  const linesToAppend = gitignoreLinesToAppend(content, packName);
  if (linesToAppend.length === 0) {
    return content;
  }

  let result = content;
  if (result.length > 0 && !result.endsWith('\n')) {
    result += '\n';
  }

  return `${result}${linesToAppend.join('\n')}\n`;
}
