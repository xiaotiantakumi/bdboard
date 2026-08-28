import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileStat, FileSystemPort } from '../../application/ports/file-system.js';
import type { Project } from '../../domain/project.js';
import { createBeadsFingerprinter } from './beads-fingerprinter.js';

interface FakeFsState {
  readonly stats: Record<string, FileStat>;
  readonly files: Record<string, string>;
}

function createFakeFs(state: FakeFsState): FileSystemPort {
  return {
    async readDir(): Promise<[]> {
      return [];
    },
    async isDirectory(): Promise<boolean> {
      return false;
    },
    async realPath(path: string): Promise<string> {
      return path;
    },
    async stat(path: string): Promise<FileStat | undefined> {
      return state.stats[path];
    },
    async readFile(path: string): Promise<string | undefined> {
      return state.files[path];
    },
    async readRange(): Promise<string | undefined> {
      return undefined;
    },
    async readRangeBytes(): Promise<Buffer | undefined> {
      return undefined;
    },
  };
}

function beadsPaths(rootPath: string) {
  // 実装は join(project.rootPath, '.beads') でネイティブ区切りを使う。fake のキーも合わせる (bdboard-9dm)。
  const beadsDir = path.join(rootPath, '.beads');
  return {
    lastTouched: path.join(beadsDir, 'last-touched'),
    interactions: path.join(beadsDir, 'interactions.jsonl'),
    dolt: path.join(beadsDir, 'embeddeddolt'),
  };
}

function project(rootPath: string): Project {
  return {
    id: rootPath,
    name: 'test',
    rootPath,
    prefixes: [],
    aliasPaths: [],
  };
}

function baseState(rootPath: string): FakeFsState {
  const paths = beadsPaths(rootPath);
  return {
    stats: {
      [paths.lastTouched]: { mtimeMs: 1000, size: 10 },
      [paths.interactions]: { mtimeMs: 2000, size: 300 },
      [paths.dolt]: { mtimeMs: 4000, size: 0 },
    },
    files: {
      [paths.lastTouched]: 'touch-content',
    },
  };
}

describe('createBeadsFingerprinter', () => {
  const rootPath = '/projects/alpha';

  it('returns the same fingerprint for identical inputs', async () => {
    const fs = createFakeFs(baseState(rootPath));
    const fingerprinter = createBeadsFingerprinter(fs);

    const first = await fingerprinter.fingerprint(project(rootPath));
    const second = await fingerprinter.fingerprint(project(rootPath));

    expect(first).toBe(second);
    expect(first).toBe(
      'last-touched:1000:touch-content|interactions:300:2000|dolt:4000',
    );
  });

  it('changes when last-touched mtime changes', async () => {
    const paths = beadsPaths(rootPath);
    const state = baseState(rootPath);
    const fs = createFakeFs(state);
    const fingerprinter = createBeadsFingerprinter(fs);

    const baseline = await fingerprinter.fingerprint(project(rootPath));

    state.stats[paths.lastTouched] = { mtimeMs: 1001, size: 10 };
    const changed = await fingerprinter.fingerprint(project(rootPath));

    expect(changed).not.toBe(baseline);
  });

  it('changes when last-touched content changes', async () => {
    const paths = beadsPaths(rootPath);
    const state = baseState(rootPath);
    const fs = createFakeFs(state);
    const fingerprinter = createBeadsFingerprinter(fs);

    const baseline = await fingerprinter.fingerprint(project(rootPath));

    state.files[paths.lastTouched] = 'different-content';
    const changed = await fingerprinter.fingerprint(project(rootPath));

    expect(changed).not.toBe(baseline);
  });

  it('changes when interactions size changes', async () => {
    const paths = beadsPaths(rootPath);
    const state = baseState(rootPath);
    const fs = createFakeFs(state);
    const fingerprinter = createBeadsFingerprinter(fs);

    const baseline = await fingerprinter.fingerprint(project(rootPath));

    state.stats[paths.interactions] = { mtimeMs: 2000, size: 301 };
    const changed = await fingerprinter.fingerprint(project(rootPath));

    expect(changed).not.toBe(baseline);
  });

  it('changes when interactions mtime changes', async () => {
    const paths = beadsPaths(rootPath);
    const state = baseState(rootPath);
    const fs = createFakeFs(state);
    const fingerprinter = createBeadsFingerprinter(fs);

    const baseline = await fingerprinter.fingerprint(project(rootPath));

    state.stats[paths.interactions] = { mtimeMs: 2001, size: 300 };
    const changed = await fingerprinter.fingerprint(project(rootPath));

    expect(changed).not.toBe(baseline);
  });

  it('changes when embeddeddolt mtime changes', async () => {
    const paths = beadsPaths(rootPath);
    const state = baseState(rootPath);
    const fs = createFakeFs(state);
    const fingerprinter = createBeadsFingerprinter(fs);

    const baseline = await fingerprinter.fingerprint(project(rootPath));

    state.stats[paths.dolt] = { mtimeMs: 4001, size: 0 };
    const changed = await fingerprinter.fingerprint(project(rootPath));

    expect(changed).not.toBe(baseline);
  });

  it('returns a deterministic fingerprint when nothing is readable', async () => {
    const fs = createFakeFs({ stats: {}, files: {} });
    const fingerprinter = createBeadsFingerprinter(fs);

    const first = await fingerprinter.fingerprint(project(rootPath));
    const second = await fingerprinter.fingerprint(project(rootPath));

    expect(first).toBe(second);
    expect(first).toBe('last-touched:-:|interactions:-:-|dolt:-');
  });
});
