import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../../domain/session.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import {
  encodeCwdForTranscript,
  normalizeSessionId,
} from '../../application/session/parse-session-file.js';
import {
  parseTranscriptTailMessages,
  type TranscriptTailMessage,
} from '../../application/transcript/parse-transcript-messages.js';

const DEFAULT_TAIL_BYTES = 256 * 1024;

export interface SessionTailReaderOptions {
  readonly projectsDir?: string;
  readonly tailBytes?: number;
}

export function createSessionTailReader(
  fs: FileSystemPort,
  options?: SessionTailReaderOptions,
): SessionTailReader {
  const projectsDir =
    options?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const tailBytes = options?.tailBytes ?? DEFAULT_TAIL_BYTES;
  const realPathMemo = new Map<string, string>();

  async function resolveCwd(rawCwd: string): Promise<string> {
    const cached = realPathMemo.get(rawCwd);
    if (cached !== undefined) {
      return cached;
    }

    let resolved = rawCwd;
    try {
      const real = await fs.realPath(rawCwd);
      if (real !== undefined && real !== '') {
        resolved = real;
      }
    } catch {
      // fall back to raw cwd
    }

    realPathMemo.set(rawCwd, resolved);
    return resolved;
  }

  async function resolveTranscriptPath(session: AgentSession): Promise<string | undefined> {
    const normalizedId = normalizeSessionId(session.sessionId);
    const rawCwd = session.cwd;
    const resolvedCwd = await resolveCwd(rawCwd);

    let transcriptPath = path.join(
      projectsDir,
      encodeCwdForTranscript(rawCwd),
      `${normalizedId}.jsonl`,
    );
    let transcriptStat = await fs.stat(transcriptPath);
    if (transcriptStat === undefined && resolvedCwd !== rawCwd) {
      transcriptPath = path.join(
        projectsDir,
        encodeCwdForTranscript(resolvedCwd),
        `${normalizedId}.jsonl`,
      );
      transcriptStat = await fs.stat(transcriptPath);
    }

    if (transcriptStat === undefined) {
      return undefined;
    }

    return transcriptPath;
  }

  return {
    async readTail(
      session: AgentSession,
      limit: number,
    ): Promise<readonly TranscriptTailMessage[] | undefined> {
      const transcriptPath = await resolveTranscriptPath(session);
      if (transcriptPath === undefined) {
        return undefined;
      }

      const stat = await fs.stat(transcriptPath);
      if (stat === undefined) {
        return undefined;
      }

      const size = stat.size;
      const readLength = Math.min(size, tailBytes);
      const start = Math.max(0, size - tailBytes);
      const text = await fs.readRange(transcriptPath, start, readLength);
      if (text === undefined) {
        return undefined;
      }

      return parseTranscriptTailMessages(text, limit);
    },
  };
}
