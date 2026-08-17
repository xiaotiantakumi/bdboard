import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import { createEmptyCfdCacheMethods, createEmptyInteractionsCacheMethods, createEmptySessionLinksCacheMethods } from '../../application/ports/board-cache-fakes.js';
import type { ModelUsageTotals } from '../../application/transcript/extract-usage.js';
import type { DirEntry, FileStat, FileSystemPort } from '../../application/ports/file-system.js';
import { encodeCwdForTranscript } from '../../application/session/parse-session-file.js';
import { createJsonlTranscriptScanner } from './jsonl-transcript-scanner.js';

const projectsDir = '/fake/projects';

interface FakeFsOptions {
  readonly dirs?: Readonly<Record<string, readonly DirEntry[]>>;
  readonly contents?: Readonly<Record<string, string>>;
  readonly stats?: Readonly<Record<string, FileStat>>;
  readonly throwOnReadDir?: string;
  readonly readRangeFails?: ReadonlySet<string>;
}

interface FakeFs extends FileSystemPort {
  readonly readDirPaths: string[];
  readonly readFilePaths: string[];
  readonly readRangeCalls: ReadonlyArray<{
    readonly path: string;
    readonly start: number;
    readonly length: number;
  }>;
}

function dir(name: string): DirEntry {
  return { name, isDirectory: true, isSymbolicLink: false };
}

function file(name: string): DirEntry {
  return { name, isDirectory: false, isSymbolicLink: false };
}

function createFakeFs(options: FakeFsOptions): FakeFs {
  const {
    dirs = {},
    contents = {},
    stats = {},
    throwOnReadDir,
    readRangeFails = new Set<string>(),
  } = options;
  const readDirPaths: string[] = [];
  const readFilePaths: string[] = [];
  const readRangeCalls: Array<{ path: string; start: number; length: number }> = [];

  return {
    readDirPaths,
    readFilePaths,
    readRangeCalls,

    async readDir(dirPath: string): Promise<readonly DirEntry[]> {
      readDirPaths.push(dirPath);
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
      return dirPath;
    },

    async stat(filePath: string): Promise<FileStat | undefined> {
      const fromStats = stats[filePath];
      if (fromStats !== undefined) {
        return fromStats;
      }
      const content = contents[filePath];
      if (content === undefined) {
        return undefined;
      }
      return { mtimeMs: 0, size: Buffer.byteLength(content, 'utf8') };
    },

    async readFile(filePath: string): Promise<string | undefined> {
      readFilePaths.push(filePath);
      return contents[filePath];
    },

    async readRange(
      filePath: string,
      start: number,
      length: number,
    ): Promise<string | undefined> {
      readRangeCalls.push({ path: filePath, start, length });
      if (readRangeFails.has(filePath)) {
        return undefined;
      }
      const content = contents[filePath];
      if (content === undefined) {
        return undefined;
      }
      return content.slice(start, start + length);
    },

    async readRangeBytes(
      filePath: string,
      start: number,
      length: number,
    ): Promise<Buffer | undefined> {
      const content = contents[filePath];
      if (content === undefined) {
        return undefined;
      }
      if (length <= 0) {
        return Buffer.alloc(0);
      }
      const readStart = start < 0 ? 0 : start;
      return Buffer.from(content, 'utf8').subarray(readStart, readStart + length);
    },
  };
}

function createInMemoryBoardCache(
  entries: readonly CachedProject[] = [],
): BoardCache & {
  readonly offsets: Map<string, number>;
  readonly usageBySession: Map<string, Map<string, ModelUsageTotals>>;
} {
  const offsets = new Map<string, number>();
  const usageBySession = new Map<string, Map<string, ModelUsageTotals>>();
  const projectEntries = new Map(entries.map((entry) => [entry.project.id, entry]));

  return {
    offsets,
    usageBySession,
    getProject(projectId: string): CachedProject | undefined {
      return projectEntries.get(projectId);
    },
    putProject(entry: CachedProject): void {
      projectEntries.set(entry.project.id, entry);
    },
    listProjects(): readonly CachedProject[] {
      return [...projectEntries.values()].sort((a, b) =>
        compareStrings(a.project.rootPath, b.project.rootPath),
      );
    },
    deleteProject(projectId: string): void {
      projectEntries.delete(projectId);
    },
    clear(): void {
      projectEntries.clear();
      offsets.clear();
      usageBySession.clear();
    },
    getTranscriptOffset(filePath: string): number | undefined {
      return offsets.get(filePath);
    },
    setTranscriptOffset(filePath: string, offset: number): void {
      offsets.set(filePath, offset);
    },
    addSessionUsage(sessionId: string, usage: ModelUsageTotals): void {
      let byModel = usageBySession.get(sessionId);
      if (byModel === undefined) {
        byModel = new Map();
        usageBySession.set(sessionId, byModel);
      }

      const existing = byModel.get(usage.model);
      if (existing === undefined) {
        byModel.set(usage.model, { ...usage });
        return;
      }

      byModel.set(usage.model, {
        model: usage.model,
        inputTokens: existing.inputTokens + usage.inputTokens,
        outputTokens: existing.outputTokens + usage.outputTokens,
        cacheCreationInputTokens:
          existing.cacheCreationInputTokens + usage.cacheCreationInputTokens,
        cacheReadInputTokens:
          existing.cacheReadInputTokens + usage.cacheReadInputTokens,
      });
    },
    getSessionUsage(sessionIds: readonly string[]): readonly ModelUsageTotals[] {
      const merged = new Map<string, ModelUsageTotals>();

      for (const sessionId of sessionIds) {
        const byModel = usageBySession.get(sessionId);
        if (byModel === undefined) {
          continue;
        }

        for (const usage of byModel.values()) {
          const existing = merged.get(usage.model);
          if (existing === undefined) {
            merged.set(usage.model, { ...usage });
            continue;
          }

          merged.set(usage.model, {
            model: usage.model,
            inputTokens: existing.inputTokens + usage.inputTokens,
            outputTokens: existing.outputTokens + usage.outputTokens,
            cacheCreationInputTokens:
              existing.cacheCreationInputTokens + usage.cacheCreationInputTokens,
            cacheReadInputTokens:
              existing.cacheReadInputTokens + usage.cacheReadInputTokens,
          });
        }
      }

      return [...merged.values()].sort((left, right) =>
        compareStrings(left.model, right.model),
      );
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...createEmptyInteractionsCacheMethods(),
    close(): void {},
  };
}

function project(
  id: string,
  rootPath: string,
  prefixes: readonly string[] = [],
  aliasPaths: readonly string[] = [],
): Project {
  return { id, name: id, rootPath, prefixes, aliasPaths };
}

function statForContent(content: string): FileStat {
  return { mtimeMs: 0, size: Buffer.byteLength(content, 'utf8') };
}

describe('createJsonlTranscriptScanner', () => {
  it('ignores directories that do not match any project', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const matchedDir = encoded;
    const unmatchedDir = 'totally-unrelated-dir';
    const transcriptPath = path.join(projectsDir, matchedDir, 'sess.jsonl');
    const content = 'hello bdboard-abc';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(matchedDir), dir(unmatchedDir)],
        [path.join(projectsDir, matchedDir)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toHaveLength(1);
    expect(fs.readDirPaths).toContain(projectsDir);
    expect(fs.readDirPaths).toContain(path.join(projectsDir, matchedDir));
    expect(fs.readDirPaths).not.toContain(path.join(projectsDir, unmatchedDir));
  });

  it('matches worktree directories by encoded root prefix', async () => {
    const rootPath = '/Users/foo/proj';
    const encoded = encodeCwdForTranscript(rootPath);
    const worktreeDir = `${encoded}--claude-worktrees-foo`;
    const transcriptPath = path.join(projectsDir, worktreeDir, 'sess.jsonl');
    const content = 'ticket bdboard-abc';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(worktreeDir)],
        [path.join(projectsDir, worktreeDir)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([
      {
        ticketId: 'bdboard-abc',
        sessionId: 'sess',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('scans subagent transcripts and attributes links to the parent session id', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const parentSessionId = 'parent-session-uuid';
    const subagentPath = path.join(
      projectsDir,
      encoded,
      parentSessionId,
      'subagents',
      'agent-deadbeef.jsonl',
    );
    const content = 'bdboard-abc';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [dir(parentSessionId)],
        [path.join(projectsDir, encoded, parentSessionId, 'subagents')]: [
          file('agent-deadbeef.jsonl'),
          file('agent-deadbeef.meta.json'),
        ],
      },
      contents: {
        [subagentPath]: content,
      },
      stats: {
        [subagentPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(fs.readDirPaths).toContain(
      path.join(projectsDir, encoded, parentSessionId, 'subagents'),
    );
    expect(links).toEqual([
      {
        ticketId: 'bdboard-abc',
        sessionId: parentSessionId,
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    expect(fs.readRangeCalls.some((call) => call.path === subagentPath)).toBe(true);
    expect(
      fs.readRangeCalls.some((call) =>
        call.path.endsWith('agent-deadbeef.meta.json'),
      ),
    ).toBe(false);
  });

  it('continues scanning when a session directory has no subagents subdirectory', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const mainTranscriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const mainContent = 'bdboard-main';
    const sessionWithoutSubagents = 'session-no-subagents';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [
          file('sess.jsonl'),
          dir(sessionWithoutSubagents),
        ],
      },
      contents: {
        [mainTranscriptPath]: mainContent,
      },
      stats: {
        [mainTranscriptPath]: statForContent(mainContent),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-main'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([
      {
        ticketId: 'bdboard-main',
        sessionId: 'sess',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('deduplicates bead links found in both main and subagent transcripts for the same session', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const parentSessionId = 'shared-session';
    const mainTranscriptPath = path.join(projectsDir, encoded, `${parentSessionId}.jsonl`);
    const subagentPath = path.join(
      projectsDir,
      encoded,
      parentSessionId,
      'subagents',
      'agent-cafebabe.jsonl',
    );
    const mainContent = 'bdboard-shared';
    const subagentContent = 'bdboard-shared again';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [
          file(`${parentSessionId}.jsonl`),
          dir(parentSessionId),
        ],
        [path.join(projectsDir, encoded, parentSessionId, 'subagents')]: [
          file('agent-cafebabe.jsonl'),
        ],
      },
      contents: {
        [mainTranscriptPath]: mainContent,
        [subagentPath]: subagentContent,
      },
      stats: {
        [mainTranscriptPath]: statForContent(mainContent),
        [subagentPath]: statForContent(subagentContent),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-shared'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([
      {
        ticketId: 'bdboard-shared',
        sessionId: parentSessionId,
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('ignores files that do not end with .jsonl', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const content = 'bdboard-abc';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [
          file('notes.txt'),
          file('sess.jsonl'),
        ],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toHaveLength(1);
    expect(fs.readRangeCalls.every((call) => call.path.endsWith('.jsonl'))).toBe(true);
  });

  it('never calls readFile for transcript files', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const content = 'bdboard-abc';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(fs.readFilePaths).toEqual([]);
  });

  it('persists offsets and reads only new bytes on the second scan', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const mutableContents: Record<string, string> = {
      [transcriptPath]: 'bdboard-abc',
    };
    const mutableStats: Record<string, FileStat> = {
      [transcriptPath]: statForContent(mutableContents[transcriptPath]),
    };

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: mutableContents,
      stats: mutableStats,
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, {
      projectsDir,
      initialTailBytes: 1024,
      budgetBytes: 1024,
    });

    const firstContent = mutableContents[transcriptPath];

    const first = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(first).toHaveLength(1);
    expect(cache.offsets.get(transcriptPath)).toBe(firstContent.length);
    const firstCall = fs.readRangeCalls[0];
    expect(firstCall).toEqual({
      path: transcriptPath,
      start: 0,
      length: firstContent.length,
    });

    mutableContents[transcriptPath] = `${firstContent} bdboard-def`;
    mutableStats[transcriptPath] = statForContent(mutableContents[transcriptPath]);

    const second = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc', 'bdboard-def'])]]),
      now: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(second).toEqual([
      {
        ticketId: 'bdboard-def',
        sessionId: 'sess',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    expect(cache.offsets.get(transcriptPath)).toBe(mutableContents[transcriptPath].length);
    const secondCall = fs.readRangeCalls[1];
    expect(secondCall).toEqual({
      path: transcriptPath,
      start: firstContent.length,
      length: ' bdboard-def'.length,
    });
  });

  it('does not link ids that are absent from knownIdsByProject', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const content = 'bdboard-abc bdboard-unknown';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([
      {
        ticketId: 'bdboard-abc',
        sessionId: 'sess',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('deduplicates links by ticketId and sessionId and sorts ascending', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptA = path.join(projectsDir, encoded, 'aaa.jsonl');
    const transcriptB = path.join(projectsDir, encoded, 'bbb.jsonl');
    const contentA = 'bdboard-abc bdboard-abc';
    const contentB = 'bdboard-def';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('aaa.jsonl'), file('bbb.jsonl')],
      },
      contents: {
        [transcriptA]: contentA,
        [transcriptB]: contentB,
      },
      stats: {
        [transcriptA]: statForContent(contentA),
        [transcriptB]: statForContent(contentB),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([
        ['p1', new Set(['bdboard-abc', 'bdboard-def'])],
      ]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([
      {
        ticketId: 'bdboard-abc',
        sessionId: 'aaa',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        ticketId: 'bdboard-def',
        sessionId: 'bbb',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('does not advance offset when readRange returns undefined', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const content = 'bdboard-abc';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
      readRangeFails: new Set([transcriptPath]),
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([]);
    expect(cache.offsets.has(transcriptPath)).toBe(false);
  });

  it('prefers the project with the longest encoded root when multiple match', async () => {
    const shortRoot = '/a/b';
    const longRoot = '/a/b/c';
    const encodedShort = encodeCwdForTranscript(shortRoot);
    const encodedLong = encodeCwdForTranscript(longRoot);
    const dirName = encodedLong;
    const transcriptPath = path.join(projectsDir, dirName, 'sess.jsonl');
    const content = 'bdboard-short bdboard-long';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(dirName)],
        [path.join(projectsDir, dirName)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [
        project('short', shortRoot, ['bdboard']),
        project('long', longRoot, ['bdboard']),
      ],
      knownIdsByProject: new Map([
        ['short', new Set(['bdboard-short'])],
        ['long', new Set(['bdboard-long'])],
      ]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(encodedLong.startsWith(encodedShort)).toBe(true);
    expect(links).toEqual([
      {
        ticketId: 'bdboard-long',
        sessionId: 'sess',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('returns an empty array when readDir(projectsDir) throws', async () => {
    const fs = createFakeFs({
      throwOnReadDir: projectsDir,
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('p1', '/proj/a', ['bdboard'])],
      knownIdsByProject: new Map([['p1', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([]);
  });

  it('does not false-match repo when dirName extends a shorter encoded root with a boundary', async () => {
    const repoRoot = '/Users/x/repo';
    const repo2Root = '/Users/x/repo2';
    const encodedRepo2 = encodeCwdForTranscript(repo2Root);
    const transcriptPath = path.join(projectsDir, encodedRepo2, 'sess.jsonl');
    const content = 'bdboard-repo2';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encodedRepo2)],
        [path.join(projectsDir, encodedRepo2)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [
        project('repo', repoRoot, ['bdboard']),
        project('repo2', repo2Root, ['bdboard']),
      ],
      knownIdsByProject: new Map([
        ['repo', new Set(['bdboard-repo'])],
        ['repo2', new Set(['bdboard-repo2'])],
      ]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([
      {
        ticketId: 'bdboard-repo2',
        sessionId: 'sess',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('does not match encoded dir names when the exact project root is absent', async () => {
    const repoRoot = '/Users/x/repo';
    const repo2Root = '/Users/x/repo2';
    const encodedRepo2 = encodeCwdForTranscript(repo2Root);
    const transcriptPath = path.join(projectsDir, encodedRepo2, 'sess.jsonl');
    const content = 'bdboard-repo2';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encodedRepo2)],
        [path.join(projectsDir, encodedRepo2)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('repo', repoRoot, ['bdboard'])],
      knownIdsByProject: new Map([['repo', new Set(['bdboard-repo2'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([]);
  });

  it('resolves transcript directories encoded from alias paths to the parent project', async () => {
    const rootPath = '/r/main';
    const aliasPath = '/w/foo';
    const encodedAlias = encodeCwdForTranscript(aliasPath);
    const transcriptPath = path.join(projectsDir, encodedAlias, 'sess.jsonl');
    const content = 'bdboard-alias';

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encodedAlias)],
        [path.join(projectsDir, encodedAlias)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    const links = await scanner.scan({
      projects: [project('main', rootPath, ['bdboard'], [aliasPath])],
      knownIdsByProject: new Map([['main', new Set(['bdboard-alias'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(links).toEqual([
      {
        ticketId: 'bdboard-alias',
        sessionId: 'sess',
        source: 'transcript',
        confidence: 0.6,
        observedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('accumulates assistant usage per session while scanning', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'hello bdboard-abc' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 20,
        },
      },
    });
    const content = `plain text bdboard-abc\n${assistantLine}`;

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: {
        [transcriptPath]: content,
      },
      stats: {
        [transcriptPath]: statForContent(content),
      },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });

    await scanner.scan({
      projects: [project('a', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['a', new Set(['bdboard-abc'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(cache.getSessionUsage(['sess'])).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 20,
      },
    ]);
  });
});
