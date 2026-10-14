import type { LocalFileKind } from '../../domain/local-file-kinds.js';
import {
  extractLocalFileCandidateLines,
  localFileResolutionAttempts,
} from '../../domain/local-file-refs.js';

export interface LocalFileRef {
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size: number | null;
}

export const LOCAL_FILE_REFS_LIMIT = 100;

interface LineAnchor {
  readonly path: string;
  readonly isDirectory: boolean;
}

/**
 * 本文群から実在するローカルファイル参照を初出順で集める。
 * 行をまたいだ解決はしない。同じ path は一度だけ。limit に達したら以降は probe しない。
 */
export async function findLocalFileRefs(
  texts: readonly string[],
  probe: (relativePath: string) => Promise<LocalFileRef | undefined>,
  limit: number = LOCAL_FILE_REFS_LIMIT,
): Promise<LocalFileRef[]> {
  const refs: LocalFileRef[] = [];
  const seen = new Set<string>();
  const cache = new Map<string, LocalFileRef | undefined>();

  const probeOnce = async (relativePath: string): Promise<LocalFileRef | undefined> => {
    if (cache.has(relativePath)) {
      return cache.get(relativePath);
    }
    const found = await probe(relativePath);
    cache.set(relativePath, found);
    return found;
  };

  for (const text of texts) {
    for (const candidates of extractLocalFileCandidateLines(text)) {
      let previous: LineAnchor | undefined;
      for (const candidate of candidates) {
        if (refs.length >= limit) {
          return refs;
        }
        const attempts = localFileResolutionAttempts(candidate, previous);
        let adopted: LocalFileRef | undefined;
        for (const attempt of attempts) {
          const found = await probeOnce(attempt);
          if (found !== undefined) {
            adopted = found;
            break;
          }
        }
        if (adopted === undefined) {
          continue;
        }
        previous = { path: adopted.path, isDirectory: adopted.kind === 'directory' };
        if (seen.has(adopted.path)) {
          continue;
        }
        seen.add(adopted.path);
        refs.push(adopted);
      }
    }
  }
  return refs;
}
