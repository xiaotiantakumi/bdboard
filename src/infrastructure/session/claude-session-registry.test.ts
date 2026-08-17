import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileStat, FileSystemPort } from '../../application/ports/file-system.js';
import type { ProcessProbe } from '../../application/ports/process-probe.js';
import { createClaudeSessionRegistry } from './claude-session-registry.js';

interface FakeFsOptions {
  readonly dirs?: Readonly<Record<string, readonly DirEntry[]>>;
  readonly files?: Readonly<Record<string, string>>;
  readonly stats?: Readonly<Record<string, FileStat>>;
  readonly throwOnReadDir?: string;
  readonly realPaths?: Readonly<Record<string, string>>;
  readonly realPathThrows?: boolean;
  readonly realPathImpl?: (dirPath: string) => Promise<string>;
}

function createFakeFs(options: FakeFsOptions): FileSystemPort & { readFilePaths: string[] } {
  const {
    dirs = {},
    files = {},
    stats = {},
    throwOnReadDir,
    realPaths = {},
    realPathThrows = false,
    realPathImpl,
  } = options;
  const readFilePaths: string[] = [];

  return {
    readFilePaths,

    async readDir(dirPath: string): Promise<readonly DirEntry[]> {
      if (throwOnReadDir !== undefined && dirPath === throwOnReadDir) {
        throw new Error(`EACCES: ${dirPath}`);
      }
      const entries = dirs[dirPath];
      if (entries === undefined) {
        throw new Error(`ENOENT: ${dirPath}`);
      }
      return entries;
    },

    async isDirectory(dirPath: string): Promise<boolean> {
      return Object.prototype.hasOwnProperty.call(dirs, dirPath);
    },

    async realPath(dirPath: string): Promise<string> {
      if (realPathImpl !== undefined) {
        return realPathImpl(dirPath);
      }
      if (realPathThrows) {
        throw new Error('realPath failed');
      }
      return realPaths[dirPath] ?? dirPath;
    },

    async stat(filePath: string): Promise<FileStat | undefined> {
      return stats[filePath];
    },

    async readFile(filePath: string): Promise<string | undefined> {
      readFilePaths.push(filePath);
      return files[filePath];
    },

    async readRange(): Promise<string | undefined> {
      return undefined;
    },

    async readRangeBytes(): Promise<Buffer | undefined> {
      return undefined;
    },
  };
}

function createFakeProbe(alivePids: ReadonlySet<number>): ProcessProbe {
  return {
    isAlive(pid: number): boolean {
      return alivePids.has(pid);
    },
  };
}

function file(name: string): DirEntry {
  return { name, isDirectory: false, isSymbolicLink: false };
}

const sessionsDir = '/fake/sessions';
const projectsDir = '/fake/projects';

describe('createClaudeSessionRegistry', () => {
  it('reads only .json files and ignores .key files', async () => {
    const sessionJson = JSON.stringify({
      pid: 100,
      sessionId: 'aaa-111',
      cwd: '/proj/a',
      startedAt: 1_000,
    });

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('100.json'), file('100.abc.key')],
      },
      files: {
        [path.join(sessionsDir, '100.json')]: sessionJson,
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([100])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('aaa-111');
  });

  it('skips broken JSON and returns other sessions', async () => {
    const goodJson = JSON.stringify({
      pid: 101,
      sessionId: 'bbb-222',
      cwd: '/proj/b',
      startedAt: 2_000,
    });

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('101.json'), file('102.json')],
      },
      files: {
        [path.join(sessionsDir, '101.json')]: goodJson,
        [path.join(sessionsDir, '102.json')]: '{not valid json',
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([101])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('bbb-222');
  });

  it('reflects probe.isAlive in alive field', async () => {
    const aliveJson = JSON.stringify({
      pid: 200,
      sessionId: 'alive-1',
      cwd: '/proj/c',
      startedAt: 3_000,
    });
    const deadJson = JSON.stringify({
      pid: 201,
      sessionId: 'dead-1',
      cwd: '/proj/d',
      startedAt: 4_000,
    });

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('200.json'), file('201.json')],
      },
      files: {
        [path.join(sessionsDir, '200.json')]: aliveJson,
        [path.join(sessionsDir, '201.json')]: deadJson,
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([200])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    const aliveSession = sessions.find((s) => s.sessionId === 'alive-1');
    const deadSession = sessions.find((s) => s.sessionId === 'dead-1');

    expect(aliveSession?.alive).toBe(true);
    expect(deadSession?.alive).toBe(false);
  });

  it('uses transcript mtimeMs for lastActivityAt', async () => {
    const cwd = '/Users/testuser/Documents/src/private_src/example-project';
    const sessionId = 'ccc-333';
    const startedAt = 5_000;
    const mtimeMs = 9_999_000;

    const sessionJson = JSON.stringify({
      pid: 300,
      sessionId,
      cwd,
      startedAt,
    });
    const encodedCwd = '-Users-testuser-Documents-src-private-src-example-project';
    const transcriptPath = path.join(projectsDir, encodedCwd, `${sessionId}.jsonl`);

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('300.json')],
      },
      files: {
        [path.join(sessionsDir, '300.json')]: sessionJson,
      },
      stats: {
        [transcriptPath]: { mtimeMs, size: 1_000_000 },
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([300])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions[0]?.lastActivityAt.getTime()).toBe(mtimeMs);
  });

  it('falls back to startedAt when transcript stat is missing', async () => {
    const startedAt = 6_000;
    const sessionJson = JSON.stringify({
      pid: 400,
      sessionId: 'ddd-444',
      cwd: '/proj/e',
      startedAt,
    });

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('400.json')],
      },
      files: {
        [path.join(sessionsDir, '400.json')]: sessionJson,
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([400])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions[0]?.lastActivityAt.getTime()).toBe(startedAt);
  });

  it('returns sessions sorted by sessionId ascending', async () => {
    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('500.json'), file('501.json'), file('502.json')],
      },
      files: {
        [path.join(sessionsDir, '500.json')]: JSON.stringify({
          pid: 500,
          sessionId: 'z-last',
          cwd: '/proj/f',
          startedAt: 1,
        }),
        [path.join(sessionsDir, '501.json')]: JSON.stringify({
          pid: 501,
          sessionId: 'a-first',
          cwd: '/proj/g',
          startedAt: 2,
        }),
        [path.join(sessionsDir, '502.json')]: JSON.stringify({
          pid: 502,
          sessionId: 'm-middle',
          cwd: '/proj/h',
          startedAt: 3,
        }),
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([500, 501, 502])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['a-first', 'm-middle', 'z-last']);
  });

  it('deduplicates sessions by normalized sessionId', async () => {
    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('600.json'), file('601.json')],
      },
      files: {
        [path.join(sessionsDir, '600.json')]: JSON.stringify({
          pid: 600,
          sessionId: 'local_dup-1',
          cwd: '/proj/i',
          startedAt: 10,
          name: 'first',
        }),
        [path.join(sessionsDir, '601.json')]: JSON.stringify({
          pid: 601,
          sessionId: 'dup-1',
          cwd: '/proj/j',
          startedAt: 20,
          name: 'second',
        }),
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([600, 601])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('dup-1');
    expect(sessions[0]?.name).toBe('first');
  });

  it('returns empty array when readDir throws', async () => {
    const fs = createFakeFs({
      throwOnReadDir: sessionsDir,
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set()), {
      sessionsDir,
      projectsDir,
    });

    await expect(registry.listSessions()).resolves.toEqual([]);
  });

  it('never calls readFile on transcript .jsonl paths', async () => {
    const cwd = '/proj/k';
    const sessionId = 'eee-555';
    const sessionJson = JSON.stringify({
      pid: 700,
      sessionId,
      cwd,
      startedAt: 7_000,
    });
    const encodedCwd = '-proj-k';
    const transcriptPath = path.join(projectsDir, encodedCwd, `${sessionId}.jsonl`);

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('700.json')],
      },
      files: {
        [path.join(sessionsDir, '700.json')]: sessionJson,
      },
      stats: {
        [transcriptPath]: { mtimeMs: 8_000, size: 500 },
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([700])), {
      sessionsDir,
      projectsDir,
    });

    await registry.listSessions();

    expect(fs.readFilePaths).toEqual([path.join(sessionsDir, '700.json')]);
    expect(fs.readFilePaths.some((p) => p.endsWith('.jsonl'))).toBe(false);
  });

  it('normalizes session cwd via realPath', async () => {
    const rawCwd = '/tmp/x';
    const resolvedCwd = '/private/tmp/x';
    const sessionJson = JSON.stringify({
      pid: 800,
      sessionId: 'realpath-1',
      cwd: rawCwd,
      startedAt: 8_000,
    });

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('800.json')],
      },
      files: {
        [path.join(sessionsDir, '800.json')]: sessionJson,
      },
      realPaths: {
        [rawCwd]: resolvedCwd,
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([800])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions[0]?.cwd).toBe(resolvedCwd);
  });

  it('falls back to the raw cwd when realPath throws', async () => {
    const rawCwd = '/tmp/broken';
    const sessionJson = JSON.stringify({
      pid: 801,
      sessionId: 'realpath-fail',
      cwd: rawCwd,
      startedAt: 8_001,
    });

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('801.json')],
      },
      files: {
        [path.join(sessionsDir, '801.json')]: sessionJson,
      },
      realPathThrows: true,
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([801])), {
      sessionsDir,
      projectsDir,
    });

    const sessions = await registry.listSessions();
    expect(sessions[0]?.cwd).toBe(rawCwd);
  });

  it('memoizes realPath across sessions and listSessions calls', async () => {
    const rawCwd = '/tmp/shared';
    const resolvedCwd = '/private/tmp/shared';
    let realPathCalls = 0;

    const fs = createFakeFs({
      dirs: {
        [sessionsDir]: [file('810.json'), file('811.json')],
      },
      files: {
        [path.join(sessionsDir, '810.json')]: JSON.stringify({
          pid: 810,
          sessionId: 'memo-a',
          cwd: rawCwd,
          startedAt: 1,
        }),
        [path.join(sessionsDir, '811.json')]: JSON.stringify({
          pid: 811,
          sessionId: 'memo-b',
          cwd: rawCwd,
          startedAt: 2,
        }),
      },
      realPathImpl: async (dirPath: string) => {
        realPathCalls += 1;
        return dirPath === rawCwd ? resolvedCwd : dirPath;
      },
    });
    const registry = createClaudeSessionRegistry(fs, createFakeProbe(new Set([810, 811])), {
      sessionsDir,
      projectsDir,
    });

    await registry.listSessions();
    await registry.listSessions();

    expect(realPathCalls).toBe(1);
  });
});
