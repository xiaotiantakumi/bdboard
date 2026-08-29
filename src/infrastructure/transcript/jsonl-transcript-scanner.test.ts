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
      const bytes = await this.readRangeBytes(filePath, start, length);
      return bytes?.toString('utf8');
    },

    // start/length は文字数ではなくバイト数。文字列 slice で代用すると多バイト文字
    // まわりで本物と挙動が変わり、フェイクの方が寛容になってしまう(bdboard-32u)。
    async readRangeBytes(
      filePath: string,
      start: number,
      length: number,
    ): Promise<Buffer | undefined> {
      readRangeCalls.push({ path: filePath, start, length });
      if (readRangeFails.has(filePath)) {
        return undefined;
      }
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
    const content = 'hello bdboard-abc\n';

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
    const content = 'ticket bdboard-abc\n';

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
    const content = 'bdboard-abc\n';

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
    const mainContent = 'bdboard-main\n';
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
    const mainContent = 'bdboard-shared\n';
    const subagentContent = 'bdboard-shared again\n';

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
    const content = 'bdboard-abc\n';

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
    const content = 'bdboard-abc\n';

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
      [transcriptPath]: 'bdboard-abc\n',
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

    // 追記は行単位。行の途中に足すと、その行は完結するまでコミットされない
    // (bdboard-32u で入れた行境界コミットの仕様)。
    mutableContents[transcriptPath] = `${firstContent}bdboard-def\n`;
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
      length: 'bdboard-def\n'.length,
    });
  });

  it('does not link ids that are absent from knownIdsByProject', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const content = 'bdboard-abc bdboard-unknown\n';

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
    const contentA = 'bdboard-abc bdboard-abc\n';
    const contentB = 'bdboard-def\n';

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
    const content = 'bdboard-abc\n';

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
    const content = 'bdboard-short bdboard-long\n';

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
    const content = 'bdboard-repo2\n';

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
    const content = 'bdboard-repo2\n';

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
    const content = 'bdboard-alias\n';

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
    const content = `plain text bdboard-abc\n${assistantLine}\n`;

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

  // bdboard-32u: 予算(budgetBytes)でスライスが行の途中で切れたとき、旧実装は
  // slice.newOffset をそのままコミットしていた。切れた行はJSONとして壊れているので
  // 今回のスキャンでは解釈されず、次回はその行の途中から読み始めるため、
  // 「一度も解釈されない行」が恒久的に生まれる。累積値である usage は取り返しがつかない。
  it('does not lose a line that a byte budget cut in half', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const usageLine = (inputTokens: number, ticketId: string): string =>
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          content: [{ type: 'text', text: `working on ${ticketId}` }],
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      })}\n`;

    const first = usageLine(100, 'bdboard-aaa');
    const second = usageLine(200, 'bdboard-bbb');
    const third = usageLine(300, 'bdboard-ccc');
    const content = `${first}${second}${third}`;
    // 1行目は丸ごと、2行目は途中まで、で予算が尽きる境界。
    const budgetBytes =
      Buffer.byteLength(first, 'utf8') + Math.floor(Buffer.byteLength(second, 'utf8') / 2);

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: { [transcriptPath]: content },
      stats: { [transcriptPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, {
      projectsDir,
      budgetBytes,
    });
    const input = {
      projects: [project('a', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([
        ['a', new Set(['bdboard-aaa', 'bdboard-bbb', 'bdboard-ccc'])],
      ]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    };

    await scanner.scan(input);
    // 切れかけの2行目は次回に持ち越すので、コミットは1行目の末尾まで。
    expect(cache.offsets.get(transcriptPath)).toBe(Buffer.byteLength(first, 'utf8'));

    // 毎回1行分ずつしか予算が無いので、追いつくには複数ティック要る。
    // 重要なのは回数ではなく「必ず追いつく」ことと「途中の行が飛ばない」こと。
    const totalBytes = Buffer.byteLength(content, 'utf8');
    const seen = new Set<string>();
    for (let tick = 0; tick < 5; tick += 1) {
      for (const link of await scanner.scan(input)) {
        seen.add(link.ticketId);
      }
      if (cache.offsets.get(transcriptPath) === totalBytes) {
        break;
      }
    }

    expect(cache.offsets.get(transcriptPath)).toBe(totalBytes);
    expect([...seen].sort()).toEqual(['bdboard-bbb', 'bdboard-ccc']);
    expect(cache.getSessionUsage(['sess'])).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 600,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    ]);
  });

  // bdboard-3tw.105 と同じ罠。行境界に揃えるだけでなく、生 Buffer 上で切ることまで
  // 含めて初めて安全になる(デコード済み文字列を再エンコードすると U+FFFD で伸びる)。
  it('keeps multibyte text intact when the budget cuts inside a character', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const first = 'これは日本語のログ行です bdboard-aaa\n';
    const second = '二行目も日本語 bdboard-bbb\n';
    const content = `${first}${second}`;
    // 1行目の末尾 + 2行目の先頭の多バイト文字の途中、で切れる予算。
    const budgetBytes = Buffer.byteLength(first, 'utf8') + 1;

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: { [transcriptPath]: content },
      stats: { [transcriptPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, {
      projectsDir,
      budgetBytes,
    });
    const input = {
      projects: [project('a', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['a', new Set(['bdboard-aaa', 'bdboard-bbb'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    };

    const firstLinks = await scanner.scan(input);
    expect(firstLinks.map((link) => link.ticketId)).toEqual(['bdboard-aaa']);
    expect(cache.offsets.get(transcriptPath)).toBe(Buffer.byteLength(first, 'utf8'));

    const secondLinks = await scanner.scan(input);
    expect(secondLinks.map((link) => link.ticketId)).toEqual(['bdboard-bbb']);
    expect(cache.offsets.get(transcriptPath)).toBe(Buffer.byteLength(content, 'utf8'));
  });

  // 末尾からの読み直し(initialTailBytes)は行頭に揃わないので、開始バイトが多バイト
  // 文字の途中に落ちうる。ここを文字列で読むと先頭の欠けたバイトが U+FFFD (3バイト)に
  // 化けてチャンク長が伸び、committedOffset が実際より進む (bdboard-3tw.105)。
  // 生 Buffer で数えている限りオフセットはファイル長ちょうどで止まる。
  it('commits a byte-exact offset when the tail restart begins mid-character', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const first = 'いちぎょうめ bdboard-aaa\n';
    const second = 'にぎょうめ bdboard-bbb\n';
    const third = 'さんぎょうめ bdboard-ccc\n';
    const content = `${first}${second}${third}`;
    const totalBytes = Buffer.byteLength(content, 'utf8');
    // start = totalBytes - initialTailBytes = 1 → 先頭の「い」(3バイト)の途中。
    const initialTailBytes = totalBytes - 1;

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: { [transcriptPath]: content },
      stats: { [transcriptPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, {
      projectsDir,
      initialTailBytes,
    });

    const links = await scanner.scan({
      projects: [project('a', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([
        ['a', new Set(['bdboard-aaa', 'bdboard-bbb', 'bdboard-ccc'])],
      ]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    // 頭の欠けた1行目は捨てる。2/3行目だけが読めていればよい。
    expect(links.map((link) => link.ticketId)).toEqual(['bdboard-bbb', 'bdboard-ccc']);
    // ファイル長を1バイトでも超えたら、次回は「巻き戻し」と誤認されて読み直しになる。
    expect(cache.offsets.get(transcriptPath)).toBe(totalBytes);
  });
});

describe('scanner liveness (bdboard-32u review)', () => {
  // fable レビュー minor: scanner 側の previousOffset > size (切り詰め/巻き戻し)
  // 分岐が一度も発火していなかった。reader 側の同型テストは start=0 になるため
  // 「先頭の欠けた行を捨てる」経路まで固定できていない。
  it('drops the partial first line when the file shrank below the stored offset', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const content = 'stale bdboard-aaa\nfresh bdboard-bbb\n';
    const mutableContents: Record<string, string> = { [transcriptPath]: content };

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: mutableContents,
      stats: { [transcriptPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    // 記録済みオフセットがファイル長より先 = ログローテート等で縮んだ状態。
    cache.setTranscriptOffset(transcriptPath, 10_000);
    const scanner = createJsonlTranscriptScanner(fs, cache, {
      projectsDir,
      // 末尾から読み直す窓を、1行目の途中から始まるように取る。
      initialTailBytes: Buffer.byteLength(content, 'utf8') - 3,
    });

    const links = await scanner.scan({
      projects: [project('a', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['a', new Set(['bdboard-aaa', 'bdboard-bbb'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    // 頭が欠けた1行目は捨てる。捨てないと壊れた行を解釈することになる。
    expect(links.map((link) => link.ticketId)).toEqual(['bdboard-bbb']);
    expect(cache.offsets.get(transcriptPath)).toBe(Buffer.byteLength(content, 'utf8'));
  });

  // 強制前進のガード側。EOF まで読み切った chunk に完結した行が1つも無い
  // ケース = 書き込み途中の行だけが新しく見えている状態。ここで前進させると、
  // まさにこの PR が直したはずの「一度も解釈されない行」を作ってしまう。
  it('waits instead of advancing past a half-written final line at EOF', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const settled = 'settled bdboard-aaa\n';
    const mutableContents: Record<string, string> = { [transcriptPath]: settled };
    const mutableStats: Record<string, FileStat> = {
      [transcriptPath]: statForContent(settled),
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
    const scanner = createJsonlTranscriptScanner(fs, cache, { projectsDir });
    const input = {
      projects: [project('a', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['a', new Set(['bdboard-aaa', 'bdboard-bbb'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    };

    await scanner.scan(input);
    const settledBytes = Buffer.byteLength(settled, 'utf8');
    expect(cache.offsets.get(transcriptPath)).toBe(settledBytes);

    // 追記の途中。改行がまだ来ていない。
    const partial = 'half-written bdboard-bbb';
    mutableContents[transcriptPath] = `${settled}${partial}`;
    mutableStats[transcriptPath] = statForContent(mutableContents[transcriptPath]);

    expect(await scanner.scan(input)).toEqual([]);
    // 進めてはいけない。進めるとこの行は完結しても二度と読まれない。
    expect(cache.offsets.get(transcriptPath)).toBe(settledBytes);

    // 書き込みが完了したら拾えること。
    mutableContents[transcriptPath] = `${settled}${partial}\n`;
    mutableStats[transcriptPath] = statForContent(mutableContents[transcriptPath]);

    const links = await scanner.scan(input);
    expect(links.map((link) => link.ticketId)).toEqual(['bdboard-bbb']);
    expect(cache.offsets.get(transcriptPath)).toBe(
      Buffer.byteLength(mutableContents[transcriptPath], 'utf8'),
    );
  });

  it('makes progress on a line longer than the whole budget', async () => {
    const rootPath = '/proj/a';
    const encoded = encodeCwdForTranscript(rootPath);
    const transcriptPath = path.join(projectsDir, encoded, 'sess.jsonl');
    const huge = `${'x'.repeat(400)} bdboard-aaa\n`;
    const after = 'bdboard-bbb\n';
    const content = `${huge}${after}`;

    const fs = createFakeFs({
      dirs: {
        [projectsDir]: [dir(encoded)],
        [path.join(projectsDir, encoded)]: [file('sess.jsonl')],
      },
      contents: { [transcriptPath]: content },
      stats: { [transcriptPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const scanner = createJsonlTranscriptScanner(fs, cache, {
      projectsDir,
      budgetBytes: 100,
    });
    const input = {
      projects: [project('a', rootPath, ['bdboard'])],
      knownIdsByProject: new Map([['a', new Set(['bdboard-aaa', 'bdboard-bbb'])]]),
      now: new Date('2026-01-01T00:00:00.000Z'),
    };

    const offsets = [];
    for (let tick = 0; tick < 20; tick += 1) {
      await scanner.scan(input);
      offsets.push(cache.offsets.get(transcriptPath) ?? 0);
    }

    expect(offsets[offsets.length - 1]).toBe(Buffer.byteLength(content, 'utf8'));
  });
});
