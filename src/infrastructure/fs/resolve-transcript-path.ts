import path from 'node:path';
import type { FileStat, FileSystemPort } from '../../application/ports/file-system.js';
import { encodeCwdForTranscript } from '../../application/session/parse-session-file.js';

const DEFAULT_NEGATIVE_TTL_MS = 30_000;

interface MemoEntry {
  readonly resolved: string;
  /** undefined means permanent (successful realPath resolution). */
  readonly expiresAt: number | undefined;
}

export interface CwdResolver {
  resolveCwd(rawCwd: string): Promise<string>;
}

export interface CwdResolverOptions {
  /** TTL for negative (realPath threw) cache entries. Default 30_000 ms. */
  readonly negativeTtlMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  readonly now?: () => number;
}

export function createCwdResolver(
  fs: FileSystemPort,
  options?: CwdResolverOptions,
): CwdResolver {
  const negativeTtlMs = options?.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const now = options?.now ?? Date.now;
  const memo = new Map<string, MemoEntry>();

  async function resolveCwd(rawCwd: string): Promise<string> {
    const cached = memo.get(rawCwd);
    if (cached !== undefined) {
      if (cached.expiresAt === undefined || cached.expiresAt > now()) {
        return cached.resolved;
      }
      memo.delete(rawCwd);
    }

    let resolved = rawCwd;
    let success = true;
    try {
      const real = await fs.realPath(rawCwd);
      if (real !== undefined && real !== '') {
        resolved = real;
      }
    } catch {
      success = false;
    }

    memo.set(rawCwd, {
      resolved,
      expiresAt: success ? undefined : now() + negativeTtlMs,
    });
    return resolved;
  }

  return { resolveCwd };
}

export interface ResolvedTranscript {
  readonly transcriptPath: string;
  readonly stat: FileStat;
}

export async function resolveTranscriptPath(
  fs: FileSystemPort,
  resolveCwd: (rawCwd: string) => Promise<string>,
  projectsDir: string,
  rawCwd: string,
  normalizedSessionId: string,
): Promise<ResolvedTranscript | undefined> {
  const resolvedCwd = await resolveCwd(rawCwd);

  let transcriptPath = path.join(
    projectsDir,
    encodeCwdForTranscript(rawCwd),
    `${normalizedSessionId}.jsonl`,
  );
  let transcriptStat = await fs.stat(transcriptPath);
  if (transcriptStat === undefined && resolvedCwd !== rawCwd) {
    transcriptPath = path.join(
      projectsDir,
      encodeCwdForTranscript(resolvedCwd),
      `${normalizedSessionId}.jsonl`,
    );
    transcriptStat = await fs.stat(transcriptPath);
  }

  if (transcriptStat === undefined) {
    return undefined;
  }

  return { transcriptPath, stat: transcriptStat };
}
