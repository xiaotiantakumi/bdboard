import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../domain/project.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import {
  createEmptyCfdCacheMethods,
  createEmptySessionLinksCacheMethods,
  createInMemoryInteractionsCacheMethods,
} from '../../application/ports/board-cache-fakes.js';
import type { DirEntry, FileStat, FileSystemPort } from '../../application/ports/file-system.js';
import { createJsonlInteractionReader } from './jsonl-interaction-reader.js';

interface FakeFsOptions {
  readonly contents?: Readonly<Record<string, string>>;
  readonly stats?: Readonly<Record<string, FileStat>>;
  readonly readRangeFails?: ReadonlySet<string>;
}

interface FakeFs extends FileSystemPort {
  readonly readRangeCalls: ReadonlyArray<{
    readonly path: string;
    readonly start: number;
    readonly length: number;
  }>;
  readonly readRangeBytesCalls: ReadonlyArray<{
    readonly path: string;
    readonly start: number;
    readonly length: number;
  }>;
}

function createFakeFs(options: FakeFsOptions): FakeFs {
  const {
    contents = {},
    stats = {},
    readRangeFails = new Set<string>(),
  } = options;
  const readRangeCalls: Array<{ path: string; start: number; length: number }> = [];
  const readRangeBytesCalls: Array<{ path: string; start: number; length: number }> = [];

  function readBytes(
    filePath: string,
    start: number,
    length: number,
  ): Buffer | undefined {
    const content = contents[filePath];
    if (content === undefined) {
      return undefined;
    }
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const readStart = start < 0 ? 0 : start;
    return Buffer.from(content, 'utf8').subarray(readStart, readStart + length);
  }

  return {
    readRangeCalls,
    readRangeBytesCalls,

    async readDir(dirPath: string): Promise<readonly DirEntry[]> {
      throw new Error(`ENOENT: ${dirPath}`);
    },

    async isDirectory(): Promise<boolean> {
      return false;
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
      const bytes = readBytes(filePath, start, length);
      return bytes?.toString('utf8');
    },

    async readRangeBytes(
      filePath: string,
      start: number,
      length: number,
    ): Promise<Buffer | undefined> {
      readRangeBytesCalls.push({ path: filePath, start, length });
      if (readRangeFails.has(filePath)) {
        return undefined;
      }
      return readBytes(filePath, start, length);
    },
  };
}

function interactionLine(
  overrides: {
    id?: string;
    kind?: string;
    created_at?: string;
    actor?: string;
    issue_id?: string;
    extra?: Record<string, string>;
  } = {},
): string {
  return JSON.stringify({
    id: overrides.id ?? 'int-fake-001',
    kind: overrides.kind ?? 'field_change',
    created_at: overrides.created_at ?? '2026-08-14T19:28:00.646456Z',
    actor: overrides.actor ?? 'example-agent',
    issue_id: overrides.issue_id ?? 'bdboard-fake-01',
    extra: overrides.extra ?? {
      field: 'status',
      old_value: 'in_progress',
      new_value: 'closed',
      reason: 'example completion reason',
    },
  });
}

function project(id: string, rootPath: string): Project {
  return { id, name: id, rootPath, prefixes: ['bdboard'], aliasPaths: [] };
}

function statForContent(content: string): FileStat {
  return { mtimeMs: 0, size: Buffer.byteLength(content, 'utf8') };
}

function createInMemoryBoardCache(): BoardCache & {
  readonly offsets: Map<string, number>;
} {
  const offsets = new Map<string, number>();
  const interactionsMethods = createInMemoryInteractionsCacheMethods();

  return {
    offsets,
    getProject(): undefined {
      return undefined;
    },
    putProject(): void {},
    listProjects(): readonly never[] {
      return [];
    },
    deleteProject(): void {},
    clear(): void {
      offsets.clear();
      interactionsMethods.interactions.clear();
    },
    getTranscriptOffset(filePath: string): number | undefined {
      return offsets.get(filePath);
    },
    setTranscriptOffset(filePath: string, offset: number): void {
      offsets.set(filePath, offset);
    },
    addSessionUsage(): void {},
    getSessionUsage(): readonly never[] {
      return [];
    },
    ...createEmptyCfdCacheMethods(),
    ...createEmptySessionLinksCacheMethods(),
    ...interactionsMethods,
    close(): void {},
  };
}

describe('createJsonlInteractionReader', () => {
  it('returns all records on the first read', async () => {
    const rootPath = '/proj/a';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const lineA = interactionLine({ id: 'int-fake-a', issue_id: 'bdboard-fake-a' });
    const lineB = interactionLine({
      id: 'int-fake-b',
      issue_id: 'bdboard-fake-b',
      extra: { field: 'priority', old_value: '2', new_value: '1' },
    });
    const content = `${lineA}\n${lineB}\n`;

    const fs = createFakeFs({
      contents: { [interactionsPath]: content },
      stats: { [interactionsPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes: 4096,
      budgetBytes: 4096,
    });

    const records = await reader.read({ projects: [project('p1', rootPath)] });

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.id)).toEqual(['int-fake-a', 'int-fake-b']);
    expect(cache.offsets.get(interactionsPath)).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('returns zero records and does not read bytes when the file is unchanged', async () => {
    const rootPath = '/proj/a';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const content = `${interactionLine()}\n`;

    const fs = createFakeFs({
      contents: { [interactionsPath]: content },
      stats: { [interactionsPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes: 4096,
      budgetBytes: 4096,
    });

    const first = await reader.read({ projects: [project('p1', rootPath)] });
    expect(first).toHaveLength(1);
    expect(fs.readRangeCalls).toHaveLength(0);
    expect(fs.readRangeBytesCalls).toHaveLength(1);

    const second = await reader.read({ projects: [project('p1', rootPath)] });
    expect(second).toEqual([]);
    expect(fs.readRangeCalls).toHaveLength(0);
    expect(fs.readRangeBytesCalls).toHaveLength(1);
  });

  it('returns only newly appended records on the next read', async () => {
    const rootPath = '/proj/a';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const mutableContents: Record<string, string> = {
      [interactionsPath]: `${interactionLine({ id: 'int-fake-old' })}\n`,
    };
    const mutableStats: Record<string, FileStat> = {
      [interactionsPath]: statForContent(mutableContents[interactionsPath]),
    };

    const fs = createFakeFs({
      contents: mutableContents,
      stats: mutableStats,
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes: 4096,
      budgetBytes: 4096,
    });

    const first = await reader.read({ projects: [project('p1', rootPath)] });
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe('int-fake-old');

    const appended = `${interactionLine({ id: 'int-fake-new', issue_id: 'bdboard-fake-new' })}\n`;
    mutableContents[interactionsPath] += appended;
    mutableStats[interactionsPath] = statForContent(mutableContents[interactionsPath]);

    const second = await reader.read({ projects: [project('p1', rootPath)] });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe('int-fake-new');
    expect(fs.readRangeBytesCalls[1]).toEqual({
      path: interactionsPath,
      start: Buffer.byteLength(`${interactionLine({ id: 'int-fake-old' })}\n`, 'utf8'),
      length: Buffer.byteLength(appended, 'utf8'),
    });
  });

  it('defers a trailing partial line until the next read completes it without duplicates', async () => {
    const rootPath = '/proj/a';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const completeLine = `${interactionLine({ id: 'int-fake-complete' })}\n`;
    const partialPrefix = '{"id":"int-fake-partial","kind":"field_change","created_at":"2026-08-14T20:00:00.000Z","actor":"example-agent","issue_id":"bdboard-fake-partial","extra":{"field":"status","new_value":"closed"';
    const mutableContents: Record<string, string> = {
      [interactionsPath]: completeLine + partialPrefix,
    };
    const mutableStats: Record<string, FileStat> = {
      [interactionsPath]: statForContent(mutableContents[interactionsPath]),
    };

    const fs = createFakeFs({
      contents: mutableContents,
      stats: mutableStats,
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes: 4096,
      budgetBytes: 4096,
    });

    const first = await reader.read({ projects: [project('p1', rootPath)] });
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe('int-fake-complete');
    expect(cache.offsets.get(interactionsPath)).toBe(Buffer.byteLength(completeLine, 'utf8'));

    mutableContents[interactionsPath] += '}}\n';
    mutableStats[interactionsPath] = statForContent(mutableContents[interactionsPath]);

    const second = await reader.read({ projects: [project('p1', rootPath)] });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe('int-fake-partial');
    expect(cache.listInteractions()).toHaveLength(2);
  });

  it('handles utf-8 content when computing byte offsets', async () => {
    const rootPath = '/proj/a';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const line = interactionLine({
      id: 'int-fake-utf8',
      extra: {
        field: 'status',
        old_value: 'in_progress',
        new_value: 'closed',
        reason: '日本語の理由テキスト',
      },
    });
    const content = `${line}\n`;

    const fs = createFakeFs({
      contents: { [interactionsPath]: content },
      stats: { [interactionsPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache);

    const records = await reader.read({ projects: [project('p1', rootPath)] });
    expect(records[0]?.reason).toBe('日本語の理由テキスト');
    expect(cache.offsets.get(interactionsPath)).toBe(Buffer.byteLength(content, 'utf8'));
    expect(cache.offsets.get(interactionsPath)).not.toBe(content.length);
  });

  it('does not throw when the file is truncated and avoids duplicate cache rows', async () => {
    const rootPath = '/proj/a';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const lineA = interactionLine({ id: 'int-fake-rotate-original' });
    const lineB = interactionLine({
      id: 'int-fake-rotate-original-b',
      issue_id: 'bdboard-fake-other',
    });
    const initialContent = `${lineA}\n${lineB}\n`;
    const mutableContents: Record<string, string> = {
      [interactionsPath]: initialContent,
    };
    const mutableStats: Record<string, FileStat> = {
      [interactionsPath]: statForContent(initialContent),
    };

    const fs = createFakeFs({
      contents: mutableContents,
      stats: mutableStats,
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes: 4096,
      budgetBytes: 4096,
    });

    await reader.read({ projects: [project('p1', rootPath)] });
    expect(cache.listInteractions()).toHaveLength(2);

    const replacement = `${interactionLine({ id: 'int-fake-new' })}\n`;
    expect(Buffer.byteLength(replacement, 'utf8')).toBeLessThan(
      Buffer.byteLength(initialContent, 'utf8'),
    );
    mutableContents[interactionsPath] = replacement;
    mutableStats[interactionsPath] = statForContent(replacement);

    const afterTruncate = await reader.read({ projects: [project('p1', rootPath)] });
    expect(afterTruncate).toHaveLength(1);
    expect(afterTruncate[0]?.id).toBe('int-fake-new');
    expect(cache.listInteractions()).toHaveLength(3);
  });

  it('skips broken and unknown-kind lines without throwing', async () => {
    const rootPath = '/proj/a';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const content = `${interactionLine({ id: 'int-fake-good' })}\n{broken json}\n${interactionLine({ id: 'int-fake-unknown', kind: 'comment_added' })}\n`;

    const fs = createFakeFs({
      contents: { [interactionsPath]: content },
      stats: { [interactionsPath]: statForContent(content) },
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache);

    const records = await reader.read({ projects: [project('p1', rootPath)] });
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('int-fake-good');
  });

  it('skips projects whose interactions file is missing without throwing', async () => {
    const fs = createFakeFs({});
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache);

    const records = await reader.read({
      projects: [project('p1', '/proj/missing')],
    });
    expect(records).toEqual([]);
  });

  it('keeps byte offset accurate when tail-restart chunk start splits a multibyte character', async () => {
    const rootPath = '/proj/mb-start';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const discardedLine = interactionLine({
      id: 'int-fake-mb-discard',
      extra: {
        field: 'status',
        old_value: 'in_progress',
        new_value: 'closed',
        reason: '日本語の理由',
      },
    });
    const keptLine = interactionLine({
      id: 'int-fake-mb-start',
      issue_id: 'bdboard-fake-kept',
      extra: {
        field: 'status',
        old_value: 'open',
        new_value: 'closed',
        reason: '保持される行',
      },
    });
    const line1Bytes = Buffer.from(`${discardedLine}\n`, 'utf8');
    const line2Bytes = Buffer.from(`${keptLine}\n`, 'utf8');
    const prefix = Buffer.alloc(400, 0x78);
    const contentBuf = Buffer.concat([prefix, line1Bytes, line2Bytes]);

    const reasonBytes = Buffer.from('日本語', 'utf8');
    const reasonStart = contentBuf.indexOf(reasonBytes);
    expect(reasonStart).toBeGreaterThan(0);
    const splitOffset = reasonStart + 1;

    const initialTailBytes = contentBuf.length - splitOffset;
    expect(initialTailBytes).toBeGreaterThan(0);
    expect(initialTailBytes).toBeLessThan(contentBuf.length);

    const fs = createFakeFs({
      contents: { [interactionsPath]: contentBuf.toString('utf8') },
      stats: { [interactionsPath]: { mtimeMs: 0, size: contentBuf.length } },
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes,
      budgetBytes: initialTailBytes,
    });

    const records = await reader.read({ projects: [project('p1', rootPath)] });

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe('int-fake-mb-start');
    expect(records[0]?.reason).toBe('保持される行');
    expect(cache.offsets.get(interactionsPath)).toBe(contentBuf.length);

    const rawChunk = contentBuf.subarray(splitOffset);
    const wrongOffset = splitOffset + Buffer.from(rawChunk.toString('utf8'), 'utf8').length;
    expect(wrongOffset).toBeGreaterThan(contentBuf.length);
    expect(cache.offsets.get(interactionsPath)).not.toBe(wrongOffset);
  });

  it('defers a trailing partial multibyte character without advancing offset too far', async () => {
    const rootPath = '/proj/mb-end';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const completeLine = interactionLine({ id: 'int-fake-mb-complete' });
    const completeBytes = Buffer.from(`${completeLine}\n`, 'utf8');
    const partialPrefix = Buffer.from(
      '{"id":"int-fake-mb-partial","kind":"field_change","created_at":"2026-08-14T20:00:00.000Z","actor":"example-agent","issue_id":"bdboard-fake-mb-partial","extra":{"field":"status","new_value":"closed","reason":"',
      'utf8',
    );
    const aiBytes = Buffer.from('あい', 'utf8');
    const partialSuffix = Buffer.concat([partialPrefix, aiBytes.subarray(0, 2)]);
    const initialBuf = Buffer.concat([completeBytes, partialSuffix]);
    const mutableContents: Record<string, string> = {
      [interactionsPath]: initialBuf.toString('utf8'),
    };
    const mutableStats: Record<string, FileStat> = {
      [interactionsPath]: { mtimeMs: 0, size: initialBuf.length },
    };

    const fs = createFakeFs({
      contents: mutableContents,
      stats: mutableStats,
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes: initialBuf.length,
      budgetBytes: initialBuf.length,
    });

    const first = await reader.read({ projects: [project('p1', rootPath)] });
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe('int-fake-mb-complete');
    expect(cache.offsets.get(interactionsPath)).toBe(completeBytes.length);

    const remainder = Buffer.concat([aiBytes.subarray(2), Buffer.from('"}}\n', 'utf8')]);
    const extendedBuf = Buffer.concat([initialBuf, remainder]);
    mutableContents[interactionsPath] = extendedBuf.toString('utf8');
    mutableStats[interactionsPath] = { mtimeMs: 0, size: extendedBuf.length };

    const second = await reader.read({ projects: [project('p1', rootPath)] });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe('int-fake-mb-partial');
    expect(second[0]?.reason).toBe('あい');
    expect(cache.offsets.get(interactionsPath)).toBe(extendedBuf.length);
    expect(cache.listInteractions()).toHaveLength(2);
  });

  it('tail-restarts on files larger than 2MB and reads the trailing line', async () => {
    const rootPath = '/proj/large-tail';
    const interactionsPath = path.join(rootPath, '.beads', 'interactions.jsonl');
    const initialTailBytes = 2 * 1024 * 1024;
    const fillerLine = `${interactionLine({ id: 'int-fake-fill' })}\n`;
    const fillerLineBytes = Buffer.byteLength(fillerLine, 'utf8');
    const repeatCount = Math.ceil((initialTailBytes + 1024) / fillerLineBytes);
    const trailingLine = interactionLine({ id: 'int-fake-large-tail' });
    const content = `${fillerLine.repeat(repeatCount)}${trailingLine}\n`;
    const contentBuf = Buffer.from(content, 'utf8');

    expect(contentBuf.length).toBeGreaterThan(initialTailBytes);

    const fs = createFakeFs({
      contents: { [interactionsPath]: content },
      stats: { [interactionsPath]: { mtimeMs: 0, size: contentBuf.length } },
    });
    const cache = createInMemoryBoardCache();
    const reader = createJsonlInteractionReader(fs, cache, {
      initialTailBytes,
      budgetBytes: initialTailBytes,
    });

    const records = await reader.read({ projects: [project('p1', rootPath)] });

    expect(records.some((record) => record.id === 'int-fake-large-tail')).toBe(true);
    expect(cache.offsets.get(interactionsPath)).toBe(contentBuf.length);
    expect(fs.readRangeBytesCalls[0]).toEqual({
      path: interactionsPath,
      start: contentBuf.length - initialTailBytes,
      length: initialTailBytes,
    });
  });
});
