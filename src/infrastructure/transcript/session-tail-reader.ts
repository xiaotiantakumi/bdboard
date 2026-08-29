import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../../domain/session.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import { normalizeSessionId } from '../../application/session/parse-session-file.js';
import {
  parseTranscriptTailMessages,
  type TranscriptTailMessage,
} from '../../application/transcript/parse-transcript-messages.js';
import {
  createCwdResolver,
  resolveTranscriptPath,
  type CwdResolverOptions,
} from '../fs/resolve-transcript-path.js';

const DEFAULT_TAIL_BYTES = 256 * 1024;

export interface SessionTailReaderOptions {
  readonly projectsDir?: string;
  readonly tailBytes?: number;
  readonly cwdResolverOptions?: CwdResolverOptions;
}

export function createSessionTailReader(
  fs: FileSystemPort,
  options?: SessionTailReaderOptions,
): SessionTailReader {
  const projectsDir =
    options?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const tailBytes = options?.tailBytes ?? DEFAULT_TAIL_BYTES;
  const { resolveCwd } = createCwdResolver(fs, options?.cwdResolverOptions);

  return {
    async readTail(
      session: AgentSession,
      limit: number,
    ): Promise<readonly TranscriptTailMessage[] | undefined> {
      const normalizedId = normalizeSessionId(session.sessionId);
      const resolved = await resolveTranscriptPath(
        fs,
        resolveCwd,
        projectsDir,
        session.cwd,
        normalizedId,
      );
      if (resolved === undefined) {
        return undefined;
      }

      const size = resolved.stat.size;
      const readLength = Math.min(size, tailBytes);
      const start = Math.max(0, size - tailBytes);
      const text = await fs.readRange(resolved.transcriptPath, start, readLength);
      if (text === undefined) {
        return undefined;
      }

      return parseTranscriptTailMessages(text, limit);
    },
  };
}
