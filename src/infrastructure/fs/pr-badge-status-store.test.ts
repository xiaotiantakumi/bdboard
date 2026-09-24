import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistedPrBadgeStatusEntry } from '../../application/board/pr-badge-status-cache.js';
import { createFilePrBadgeStatusStore } from './pr-badge-status-store.js';

describe('createFilePrBadgeStatusStore', () => {
  let tmpDir: string;
  let filePath: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      const resolvedTmpDir = path.resolve(tmpDir);
      const resolvedTmpRoot = path.resolve(os.tmpdir());
      expect(resolvedTmpDir.startsWith(resolvedTmpRoot)).toBe(true);
      // 書き込み禁止のまま残しているテストがあるので rmSync 前に戻す。
      chmodSync(resolvedTmpDir, 0o700);
      rmSync(resolvedTmpDir, { recursive: true, force: true });
    }
  });

  function makeStore(): ReturnType<typeof createFilePrBadgeStatusStore> {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-pr-badge-status-'));
    filePath = path.join(tmpDir, 'pr-badge-status-cache.json');
    return createFilePrBadgeStatusStore(filePath);
  }

  const entry: PersistedPrBadgeStatusEntry = {
    url: 'https://github.com/xiaotiantakumi/bdboard/pull/1',
    status: { state: 'merged', checkStatus: 'pass' },
    fetchedAt: 1_700_000_000_000,
    mergedPendingRetries: 0,
  };

  it('returns an empty array when the file does not exist', () => {
    const store = makeStore();
    expect(store.read()).toEqual([]);
  });

  it('round-trips write and read', () => {
    const store = makeStore();
    store.write([entry]);
    expect(store.read()).toEqual([entry]);
  });

  it('creates the parent directory on write if missing', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-pr-badge-status-'));
    filePath = path.join(tmpDir, 'nested', 'dir', 'pr-badge-status-cache.json');
    const store = createFilePrBadgeStatusStore(filePath);

    store.write([entry]);

    expect(store.read()).toEqual([entry]);
  });

  it('writes only an entries array to the file', () => {
    const store = makeStore();
    store.write([entry]);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['entries']);
    expect(parsed.entries).toEqual([entry]);
  });

  it('degrades to an empty array for invalid JSON without throwing', () => {
    const store = makeStore();
    writeFileSync(filePath, '{not json', 'utf8');
    expect(store.read()).toEqual([]);
  });

  it('degrades to an empty array when entries is not an array', () => {
    const store = makeStore();
    writeFileSync(filePath, JSON.stringify({ entries: 'not-an-array' }), 'utf8');
    expect(store.read()).toEqual([]);
  });

  it('degrades to an empty array when the top-level value is unrelated JSON', () => {
    const store = makeStore();
    writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf8');
    expect(store.read()).toEqual([]);
  });

  it('does not throw when the file cannot be read (permission denied)', () => {
    const store = makeStore();
    store.write([entry]);
    chmodSync(filePath, 0o000);

    expect(() => store.read()).not.toThrow();

    chmodSync(filePath, 0o600);
  });

  it('does not throw when the target directory is not writable', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-pr-badge-status-'));
    filePath = path.join(tmpDir, 'pr-badge-status-cache.json');
    const store = createFilePrBadgeStatusStore(filePath);
    chmodSync(tmpDir, 0o500);

    expect(() => store.write([entry])).not.toThrow();
  });
});
