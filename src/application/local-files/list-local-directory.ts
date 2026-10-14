import { compareStrings } from '../../domain/compare.js';
import { localFileTypeForPath, type LocalFileKind } from '../../domain/local-file-kinds.js';
import type { FileSystemPort } from '../ports/file-system.js';
import { resolveContainedLocalPath } from './resolve-contained-local-path.js';

export const LOCAL_DIRECTORY_LIST_LIMIT = 500;

export interface LocalDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size: number | null;
}

export type LocalDirectoryListing =
  | {
      readonly ok: true;
      readonly path: string;
      readonly entries: readonly LocalDirectoryEntry[];
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'not-found' | 'unsupported-type' | 'not-a-directory';
    };

const collator = new Intl.Collator('en', { numeric: true });

/**
 * 閉じ込め済みディレクトリの直下を、許可拡張子のファイルとフォルダだけ名前の自然順で返す。
 * 各項目は resolveContainedLocalPath を通し、シンボリックリンクの脱出と隠しセグメントを落とす。
 */
export async function listLocalDirectory(
  fs: Pick<FileSystemPort, 'realPath' | 'stat' | 'isDirectory' | 'readDir'>,
  rootPath: string,
  requestedPath: string,
  limit: number = LOCAL_DIRECTORY_LIST_LIMIT,
): Promise<LocalDirectoryListing> {
  const dir = await resolveContainedLocalPath(fs, rootPath, requestedPath);
  if (!dir.ok) {
    return { ok: false, reason: dir.reason };
  }
  if (!dir.isDirectory) {
    return { ok: false, reason: 'not-a-directory' };
  }

  let listed: Awaited<ReturnType<FileSystemPort['readDir']>>;
  try {
    listed = await fs.readDir(dir.realPath);
  } catch {
    return { ok: false, reason: 'not-found' };
  }

  const candidates = listed
    .filter(
      (entry) =>
        !entry.name.startsWith('.') &&
        (entry.isDirectory ||
          entry.isSymbolicLink ||
          localFileTypeForPath(entry.name) !== undefined),
    )
    .sort((left, right) => {
      const numeric = collator.compare(left.name, right.name);
      return numeric !== 0 ? numeric : compareStrings(left.name, right.name);
    });

  const entries: LocalDirectoryEntry[] = [];
  let truncated = false;
  for (const candidate of candidates) {
    if (entries.length >= limit) {
      truncated = true;
      break;
    }
    const contained = await resolveContainedLocalPath(
      fs,
      rootPath,
      `${dir.relativePath}/${candidate.name}`,
    );
    if (!contained.ok) {
      continue;
    }
    entries.push({
      name: candidate.name,
      path: contained.relativePath,
      kind: contained.kind,
      size: contained.size,
    });
  }

  return { ok: true, path: dir.relativePath, entries, truncated };
}
