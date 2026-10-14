import { localFileTypeForPath } from './local-file-kinds.js';
import { normalizeLocalRelativePath } from './local-file-path.js';

const PATH_TOKEN = /[A-Za-z0-9._/-]+/g;
const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[!-~]*/g;

function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0) {
    const char = token.charAt(end - 1);
    if (char !== '.' && char !== ',' && char !== ':' && char !== ';') {
      break;
    }
    end -= 1;
  }
  return token.slice(0, end);
}

function candidateFromToken(token: string): string | undefined {
  const stripped = stripTrailingPunctuation(token);
  if (stripped.length === 0) {
    return undefined;
  }
  if (!stripped.includes('/') && localFileTypeForPath(stripped) === undefined) {
    return undefined;
  }
  return normalizeLocalRelativePath(stripped);
}

function candidatesInLine(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(PATH_TOKEN)) {
    const index = match.index;
    if (index > 0 && line.charAt(index - 1) === '~') {
      continue;
    }
    const candidate = candidateFromToken(match[0]);
    if (candidate !== undefined) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * 本文を行ごとに分け、パス候補を出現順で返す。実在確認はしない。
 * URL らしき部分は先に消す。正規化できないトークンは捨てる。
 */
export function extractLocalFileCandidateLines(text: string): string[][] {
  const withoutUrls = text.replace(URL_LIKE, ' ');
  return withoutUrls.split(/\r?\n/).map(candidatesInLine);
}

function parentDirectory(path: string): string | undefined {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) {
    return undefined;
  }
  return path.slice(0, slash);
}

function baseDirectory(previous: { path: string; isDirectory: boolean }): string | undefined {
  if (!previous.isDirectory) {
    return parentDirectory(previous.path);
  }
  return previous.path.length > 0 ? previous.path : undefined;
}

function pushUnique(attempts: string[], path: string): void {
  if (!attempts.includes(path)) {
    attempts.push(path);
  }
}

/**
 * 根からの候補を先に、直前に解決したパスの祖先フォルダを近い順に続ける。
 * スラッシュを含まない名前は基準フォルダだけ。基準が根なら足さない。
 */
export function localFileResolutionAttempts(
  candidate: string,
  previousResolved: { path: string; isDirectory: boolean } | undefined,
): string[] {
  const attempts = [candidate];
  if (previousResolved === undefined) {
    return attempts;
  }
  const base = baseDirectory(previousResolved);
  if (base === undefined) {
    return attempts;
  }
  if (!candidate.includes('/')) {
    pushUnique(attempts, `${base}/${candidate}`);
    return attempts;
  }
  let folder: string | undefined = base;
  while (folder !== undefined) {
    pushUnique(attempts, `${folder}/${candidate}`);
    folder = parentDirectory(folder);
  }
  return attempts;
}
