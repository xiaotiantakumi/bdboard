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
import { createFileAiQuotaAlertConfigStore } from './ai-quota-alert-config-store.js';

describe('createFileAiQuotaAlertConfigStore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePath(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-ai-quota-alert-'));
    return path.join(tmpDir, 'nested', 'config.json');
  }

  it('returns undefined when absent', async () => {
    expect(await createFileAiQuotaAlertConfigStore(makePath()).read()).toBeUndefined();
  });

  it('round-trips a config and writes pretty JSON', async () => {
    const filePath = makePath();
    const store = createFileAiQuotaAlertConfigStore(filePath);
    const config = { thresholdPercent: 25 } as const;
    await store.write(config);
    expect(await store.read()).toEqual(config);
    expect(readFileSync(filePath, 'utf8')).toContain('\n  "thresholdPercent"');
  });

  it('ignores invalid values while keeping valid ones', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        thresholdPercent: 'bad',
        stalledAfterMs: 86_400_000,
      }),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await createFileAiQuotaAlertConfigStore(filePath).read()).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects out-of-range thresholdPercent on read', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        thresholdPercent: 0,
        stalledAfterMs: 86_400_000,
      }),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await createFileAiQuotaAlertConfigStore(filePath).read()).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves other keys when writing ai quota alert config to the same file', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        scanRoots: ['/keep-me'],
        stalledAfterMs: 86_400_000,
      }),
      'utf8',
    );

    await createFileAiQuotaAlertConfigStore(filePath).write({ thresholdPercent: 30 });

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      scanRoots: ['/keep-me'],
      stalledAfterMs: 86_400_000,
      thresholdPercent: 30,
    });
  });

  it('does not leave a temp file behind after a write (atomic rename)', async () => {
    const filePath = makePath();
    await createFileAiQuotaAlertConfigStore(filePath).write({ thresholdPercent: 15 });

    expect(readdirSync(path.dirname(filePath))).toEqual(['config.json']);
  });
});
