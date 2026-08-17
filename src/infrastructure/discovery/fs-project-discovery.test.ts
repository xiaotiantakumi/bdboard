import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFsProjectDiscovery } from './fs-project-discovery.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { ScanRootsConfigPort } from '../../application/ports/scan-roots-config.js';

const FAILING_COMMAND_RUNNER: CommandRunner = {
  run: async () => ({ stdout: '', stderr: '', exitCode: 1 }),
};

/** A fake FileSystemPort that only "sees" a single .beads dir directly under
 *  `fallbackRoot` — enough to prove that `resolveDefaultScanRoots`'s result
 *  (real `os.homedir()`, since `createFsProjectDiscovery` doesn't expose a
 *  homedir-injection hook) is actually what gets scanned, rather than a test
 *  double that happens to also produce an empty result either way. */
function createFallbackOnlyFs(fallbackRoot: string): FileSystemPort {
  return {
    readDir: async (target: string) =>
      target === fallbackRoot
        ? [{ name: '.beads', isDirectory: true, isSymbolicLink: false }]
        : [],
    isDirectory: async (target: string) => target === fallbackRoot,
    realPath: async (target: string) => target,
    stat: async () => undefined,
    readFile: async () => undefined,
    readRange: async () => undefined,
    readRangeBytes: async () => undefined,
  };
}

describe('createFsProjectDiscovery', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-'));

    await fs.mkdir(path.join(tmpDir, 'proj-a', '.beads'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'proj-b', 'nested', '.beads'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'proj-c', 'node_modules', 'x', '.beads'), { recursive: true });
  });

  afterAll(async () => {
    const resolvedTmpDir = await fs.realpath(tmpDir);
    const resolvedTmpRoot = await fs.realpath(os.tmpdir());
    if (!resolvedTmpDir.startsWith(resolvedTmpRoot)) {
      throw new Error(`refusing to delete path outside tmpdir: ${resolvedTmpDir}`);
    }
    await fs.rm(resolvedTmpDir, { recursive: true, force: true });
  });

  it('discovers projects with .beads but not under node_modules', async () => {
    const discovery = createFsProjectDiscovery({ scanRoots: [tmpDir] });
    const projects = await discovery.discover();

    const rootPaths = projects.map((project) => project.rootPath).sort();
    const expectedA = await fs.realpath(path.join(tmpDir, 'proj-a'));
    const expectedB = await fs.realpath(path.join(tmpDir, 'proj-b', 'nested'));

    expect(rootPaths).toEqual([expectedA, expectedB].sort());
    expect(rootPaths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('uses non-empty saved roots and merges saved excludes', async () => {
    const savedRoot = path.join(tmpDir, 'proj-a');
    const resolvedSavedRoot = await fs.realpath(savedRoot);
    const store: ScanRootsConfigPort = {
      read: async () => ({ scanRoots: [savedRoot], excludePaths: [resolvedSavedRoot] }),
      write: async () => undefined,
    };
    const discovery = createFsProjectDiscovery(undefined, { scanRootsConfigStore: store });
    await expect(discovery.discover()).resolves.toEqual([]);
  });

  it('uses non-empty saved roots and finds the project when excludePaths is empty', async () => {
    const savedRoot = path.join(tmpDir, 'proj-a');
    const expectedA = await fs.realpath(savedRoot);
    const store: ScanRootsConfigPort = {
      read: async () => ({ scanRoots: [savedRoot], excludePaths: [] }),
      write: async () => undefined,
    };
    const discovery = createFsProjectDiscovery(undefined, { scanRootsConfigStore: store });
    const projects = await discovery.discover();
    expect(projects.map((project) => project.rootPath)).toEqual([expectedA]);
  });

  it('does not read the saved config when scanRoots is explicitly provided', async () => {
    const read = vi.fn(async () => ({
      scanRoots: [path.join(tmpDir, 'proj-a')],
      excludePaths: [],
    }));
    const store: ScanRootsConfigPort = { read, write: async () => undefined };
    const discovery = createFsProjectDiscovery(
      { scanRoots: [tmpDir] },
      { scanRootsConfigStore: store },
    );

    await discovery.discover();

    expect(read).not.toHaveBeenCalled();
  });

  it('falls back to the real OS default (~/Documents) when saved roots are empty', async () => {
    const fallbackRoot = path.join(os.homedir(), 'Documents');
    const store: ScanRootsConfigPort = {
      read: async () => ({ scanRoots: [], excludePaths: [] }),
      write: async () => undefined,
    };
    const discovery = createFsProjectDiscovery(undefined, {
      fs: createFallbackOnlyFs(fallbackRoot),
      commandRunner: FAILING_COMMAND_RUNNER,
      scanRootsConfigStore: store,
    });

    const projects = await discovery.discover();

    expect(projects.map((project) => project.rootPath)).toEqual([fallbackRoot]);
  });

  it('honors BDBOARD_SCAN_DIR_LIMIT and truncates the walk with a warning', async () => {
    vi.stubEnv('BDBOARD_SCAN_DIR_LIMIT', '1');
    const logWarn = vi.fn();
    try {
      const discovery = createFsProjectDiscovery({ scanRoots: [tmpDir] }, { logWarn });
      const projects = await discovery.discover();

      // 上限1: tmpDir 自体の訪問で予算が尽き、配下のプロジェクトは見つからない。
      expect(projects).toEqual([]);
      expect(logWarn).toHaveBeenCalledOnce();
      expect(logWarn.mock.calls[0]?.[0]).toContain(tmpDir);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores an invalid BDBOARD_SCAN_DIR_LIMIT and scans normally', async () => {
    vi.stubEnv('BDBOARD_SCAN_DIR_LIMIT', 'not-a-number');
    const logWarn = vi.fn();
    try {
      const discovery = createFsProjectDiscovery({ scanRoots: [tmpDir] }, { logWarn });
      const projects = await discovery.discover();

      expect(projects.length).toBeGreaterThan(0);
      expect(logWarn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('applies saved excludePaths together with the OS-default fallback', async () => {
    const fallbackRoot = path.join(os.homedir(), 'Documents');
    const store: ScanRootsConfigPort = {
      read: async () => ({ scanRoots: [], excludePaths: [fallbackRoot] }),
      write: async () => undefined,
    };
    const discovery = createFsProjectDiscovery(undefined, {
      fs: createFallbackOnlyFs(fallbackRoot),
      commandRunner: FAILING_COMMAND_RUNNER,
      scanRootsConfigStore: store,
    });

    const projects = await discovery.discover();

    expect(projects).toEqual([]);
  });
});
