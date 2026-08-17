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
import { createFileBoardThresholdsConfigStore } from './board-thresholds-config-store.js';

describe('createFileBoardThresholdsConfigStore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePath(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-board-thresholds-'));
    return path.join(tmpDir, 'nested', 'config.json');
  }

  it('returns undefined when absent', async () => {
    expect(await createFileBoardThresholdsConfigStore(makePath()).read()).toBeUndefined();
  });

  it('round-trips a config and writes pretty JSON', async () => {
    const filePath = makePath();
    const store = createFileBoardThresholdsConfigStore(filePath);
    const config = {
      stalledAfterMs: 86_400_000,
      livenessActiveMs: 120_000,
      livenessIdleMs: 1_800_000,
      livenessStaleMs: 86_400_000,
    } as const;
    await store.write(config);
    expect(await store.read()).toEqual(config);
    expect(readFileSync(filePath, 'utf8')).toContain('\n  "stalledAfterMs"');
  });

  it('ignores invalid keys while keeping valid ones', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        stalledAfterMs: 86_400_000,
        livenessActiveMs: 'bad',
        livenessIdleMs: -1,
        livenessStaleMs: 1.5,
      }),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await createFileBoardThresholdsConfigStore(filePath).read()).toEqual({
        stalledAfterMs: 86_400_000,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves scanRoots when writing board thresholds to the same file', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        scanRoots: ['/keep-me'],
        excludePaths: ['/tmp'],
      }),
      'utf8',
    );

    await createFileBoardThresholdsConfigStore(filePath).write({
      stalledAfterMs: 12 * 60 * 60_000,
      livenessActiveMs: 60_000,
    });

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      scanRoots: ['/keep-me'],
      excludePaths: ['/tmp'],
      stalledAfterMs: 12 * 60 * 60_000,
      livenessActiveMs: 60_000,
    });
  });

  it('does not leave a temp file behind after a write (atomic rename)', async () => {
    const filePath = makePath();
    await createFileBoardThresholdsConfigStore(filePath).write({
      stalledAfterMs: 86_400_000,
    });

    expect(readdirSync(path.dirname(filePath))).toEqual(['config.json']);
  });
});
