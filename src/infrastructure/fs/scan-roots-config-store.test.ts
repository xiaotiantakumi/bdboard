import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileScanRootsConfigStore } from './scan-roots-config-store.js';

describe('createFileScanRootsConfigStore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePath(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-scan-roots-'));
    return path.join(tmpDir, 'nested', 'config.json');
  }

  it('returns undefined when absent', async () => {
    expect(await createFileScanRootsConfigStore(makePath()).read()).toBeUndefined();
  });

  it('round-trips a config and writes pretty JSON', async () => {
    const filePath = makePath();
    const store = createFileScanRootsConfigStore(filePath);
    const config = { scanRoots: ['/one', '/two'], excludePaths: ['/one/tmp'] } as const;
    await store.write(config);
    expect(await store.read()).toEqual(config);
    expect(readFileSync(filePath, 'utf8')).toContain('\n  "scanRoots"');
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['wrong shape', JSON.stringify({ scanRoots: 'not-an-array' })],
    ['wrong exclude shape', JSON.stringify({ scanRoots: [], excludePaths: [1] })],
  ])('returns undefined for %s', async (_label, contents) => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf8');
    expect(await createFileScanRootsConfigStore(filePath).read()).toBeUndefined();
  });

  it('defaults omitted excludePaths to an empty array', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ scanRoots: ['/one'] }), 'utf8');
    expect(await createFileScanRootsConfigStore(filePath).read()).toEqual({
      scanRoots: ['/one'],
      excludePaths: [],
    });
  });

  it('preserves unrelated keys already in the file when writing', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ scanRoots: ['/old'], excludePaths: [], someOtherSetting: 'keep-me' }),
      'utf8',
    );

    await createFileScanRootsConfigStore(filePath).write({
      scanRoots: ['/new'],
      excludePaths: ['/new/tmp'],
    });

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      scanRoots: ['/new'],
      excludePaths: ['/new/tmp'],
      someOtherSetting: 'keep-me',
    });
  });

  it('overwrites outright when the existing file is corrupt', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{not json', 'utf8');

    await createFileScanRootsConfigStore(filePath).write({
      scanRoots: ['/new'],
      excludePaths: [],
    });

    expect(JSON.parse(readFileSync(filePath, 'utf8')) as unknown).toEqual({
      scanRoots: ['/new'],
      excludePaths: [],
    });
  });

  it('does not leave a temp file behind after a write (atomic rename)', async () => {
    const filePath = makePath();
    await createFileScanRootsConfigStore(filePath).write({
      scanRoots: ['/one'],
      excludePaths: [],
    });

    expect(readdirSync(path.dirname(filePath))).toEqual(['config.json']);
  });

  it('warns exactly once when the file is unreadable JSON, and not when the file is simply absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const missingPath = makePath();
      await createFileScanRootsConfigStore(missingPath).read();
      expect(warn).not.toHaveBeenCalled();

      const corruptPath = makePath();
      mkdirSync(path.dirname(corruptPath), { recursive: true });
      writeFileSync(corruptPath, '{not json', 'utf8');
      await createFileScanRootsConfigStore(corruptPath).read();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(corruptPath);
    } finally {
      warn.mockRestore();
    }
  });
});
