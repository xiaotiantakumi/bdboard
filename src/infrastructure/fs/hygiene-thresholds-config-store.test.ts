import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileHygieneThresholdsConfigStore } from './hygiene-thresholds-config-store.js';

describe('createFileHygieneThresholdsConfigStore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePath(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-hygiene-thresholds-'));
    return path.join(tmpDir, 'nested', 'config.json');
  }

  it('returns undefined when absent', async () => {
    expect(await createFileHygieneThresholdsConfigStore(makePath()).read()).toBeUndefined();
  });

  it('round-trips a config and writes pretty JSON', async () => {
    const filePath = makePath();
    const store = createFileHygieneThresholdsConfigStore(filePath);
    const config = {
      staleInProgressAfterMs: 5 * 24 * 60 * 60_000,
      highPriorityMax: 2,
      stalePendingDecisionAfterMs: 2 * 24 * 60 * 60_000,
      closedWithoutEvidenceWindowMs: 4 * 24 * 60 * 60_000,
    } as const;
    await store.write(config);
    expect(await store.read()).toEqual(config);
    expect(readFileSync(filePath, 'utf8')).toContain('\n  "highPriorityMax"');
  });

  it('ignores invalid values while keeping valid ones', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        staleInProgressAfterMs: 'bad',
        highPriorityMax: 1,
      }),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await createFileHygieneThresholdsConfigStore(filePath).read()).toEqual({
        highPriorityMax: 1,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects out-of-range highPriorityMax on read', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ highPriorityMax: 9, staleInProgressAfterMs: 86_400_000 }),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await createFileHygieneThresholdsConfigStore(filePath).read()).toEqual({
        staleInProgressAfterMs: 86_400_000,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
