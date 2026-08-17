import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../domain/session.js';
import type { FileStat, FileSystemPort } from '../../application/ports/file-system.js';
import {
  encodeCwdForTranscript,
  normalizeSessionId,
} from '../../application/session/parse-session-file.js';
import { createSessionTailReader } from './session-tail-reader.js';

interface FakeFsOptions {
  readonly stats?: ReadonlyMap<string, FileStat>;
  readonly ranges?: ReadonlyMap<string, string>;
  readonly realPaths?: ReadonlyMap<string, string>;
}

function createFakeFs(options: FakeFsOptions = {}): FileSystemPort & {
  readonly readRangeCalls: ReadonlyArray<{
    path: string;
    start: number;
    length: number;
  }>;
} {
  const stats = options.stats ?? new Map<string, FileStat>();
  const ranges = options.ranges ?? new Map<string, string>();
  const realPaths = options.realPaths ?? new Map<string, string>();
  const readRangeCalls: Array<{ path: string; start: number; length: number }> = [];

  return {
    readRangeCalls,
    async readDir() {
      return [];
    },
    async isDirectory() {
      return false;
    },
    async realPath(filePath: string) {
      return realPaths.get(filePath) ?? filePath;
    },
    async stat(filePath: string) {
      return stats.get(filePath);
    },
    async readFile() {
      return undefined;
    },
    async readRange(filePath: string, start: number, length: number) {
      readRangeCalls.push({ path: filePath, start, length });
      return ranges.get(filePath);
    },
    async readRangeBytes(): Promise<Buffer | undefined> {
      return undefined;
    },
  };
}

function makeSession(
  overrides: Partial<AgentSession> & Pick<AgentSession, 'sessionId' | 'cwd'>,
): AgentSession {
  return {
    pid: 1,
    startedAt: new Date('2026-06-01T12:00:00.000Z'),
    lastActivityAt: new Date('2026-06-01T12:00:00.000Z'),
    alive: true,
    ...overrides,
  };
}

describe('createSessionTailReader', () => {
  it('returns undefined when transcript stat is missing', async () => {
    const projectsDir = path.join(os.tmpdir(), 'bdboard-tail-test-missing');
    const cwd = '/projects/a';
    const sessionId = 'session-abc';
    const fs = createFakeFs();
    const reader = createSessionTailReader(fs, { projectsDir });

    const result = await reader.readTail(
      makeSession({ sessionId, cwd }),
      50,
    );

    expect(result).toBeUndefined();
    expect(fs.readRangeCalls).toHaveLength(0);
  });

  it('reads tail bytes with correct offset and parses messages', async () => {
    const projectsDir = path.join(os.tmpdir(), 'bdboard-tail-test-read');
    const cwd = '/projects/a';
    const sessionId = 'session-abc';
    const normalizedId = normalizeSessionId(sessionId);
    const transcriptPath = path.join(
      projectsDir,
      encodeCwdForTranscript(cwd),
      `${normalizedId}.jsonl`,
    );
    const fileSize = 300 * 1024;
    const tailText = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'tail message' },
    });

    const fs = createFakeFs({
      stats: new Map([[transcriptPath, { mtimeMs: 0, size: fileSize }]]),
      ranges: new Map([[transcriptPath, tailText]]),
    });
    const reader = createSessionTailReader(fs, {
      projectsDir,
      tailBytes: 256 * 1024,
    });

    const result = await reader.readTail(
      makeSession({ sessionId, cwd }),
      50,
    );

    expect(result).toEqual([{ role: 'user', text: 'tail message' }]);
    expect(fs.readRangeCalls).toEqual([
      {
        path: transcriptPath,
        start: fileSize - 256 * 1024,
        length: 256 * 1024,
      },
    ]);
  });

  it('retries transcript path with resolved cwd when raw cwd misses', async () => {
    const projectsDir = path.join(os.tmpdir(), 'bdboard-tail-test-resolved');
    const rawCwd = '/projects/alias';
    const resolvedCwd = '/projects/real';
    const sessionId = 'session-resolved';
    const normalizedId = normalizeSessionId(sessionId);
    const resolvedPath = path.join(
      projectsDir,
      encodeCwdForTranscript(resolvedCwd),
      `${normalizedId}.jsonl`,
    );
    const tailText = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'resolved cwd' },
    });

    const fs = createFakeFs({
      stats: new Map([[resolvedPath, { mtimeMs: 0, size: 128 }]]),
      ranges: new Map([[resolvedPath, tailText]]),
      realPaths: new Map([[rawCwd, resolvedCwd]]),
    });
    const reader = createSessionTailReader(fs, { projectsDir });

    const result = await reader.readTail(
      makeSession({ sessionId, cwd: rawCwd }),
      50,
    );

    expect(result).toEqual([{ role: 'assistant', text: 'resolved cwd' }]);
    expect(fs.readRangeCalls).toHaveLength(1);
    expect(fs.readRangeCalls[0]?.path).toBe(resolvedPath);
  });
});
