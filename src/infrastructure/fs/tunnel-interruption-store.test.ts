import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileTunnelInterruptionStore } from './tunnel-interruption-store.js';

describe('createFileTunnelInterruptionStore', () => {
  let tmpDir: string;
  let filePath: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      const resolvedTmpDir = path.resolve(tmpDir);
      const resolvedTmpRoot = path.resolve(os.tmpdir());
      expect(resolvedTmpDir.startsWith(resolvedTmpRoot)).toBe(true);
      rmSync(resolvedTmpDir, { recursive: true, force: true });
    }
  });

  function makeStore(): ReturnType<typeof createFileTunnelInterruptionStore> {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-tunnel-interruption-'));
    filePath = path.join(tmpDir, 'tunnel-interruption.json');
    return createFileTunnelInterruptionStore(filePath);
  }

  it('returns null when the file does not exist', () => {
    const store = makeStore();
    expect(store.read()).toBeNull();
  });

  it('round-trips markInterrupted and read', () => {
    const store = makeStore();
    const at = new Date('2026-08-15T03:00:00.000Z');

    store.markInterrupted(at);

    expect(store.read()?.toISOString()).toBe(at.toISOString());
  });

  it('returns null after clear', () => {
    const store = makeStore();
    store.markInterrupted(new Date('2026-08-15T03:00:00.000Z'));
    store.clear();
    expect(store.read()).toBeNull();
    expect(existsSync(filePath)).toBe(false);
  });

  it('writes only interruptedAt to the file', () => {
    const store = makeStore();
    const at = new Date('2026-08-15T03:00:00.000Z');

    store.markInterrupted(at);

    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['interruptedAt']);
    expect(parsed.interruptedAt).toBe(at.toISOString());
  });

  it('returns null for invalid JSON without throwing', () => {
    const store = makeStore();
    writeFileSync(filePath, '{not json', 'utf8');
    expect(store.read()).toBeNull();
  });

  it('returns null when interruptedAt is missing', () => {
    const store = makeStore();
    writeFileSync(filePath, '{}', 'utf8');
    expect(store.read()).toBeNull();
  });

  it('returns null when interruptedAt is not a valid date string', () => {
    const store = makeStore();
    writeFileSync(filePath, JSON.stringify({ interruptedAt: 'not-a-date' }), 'utf8');
    expect(store.read()).toBeNull();
  });

  it('returns null when interruptedAt is a number', () => {
    const store = makeStore();
    writeFileSync(filePath, JSON.stringify({ interruptedAt: 123 }), 'utf8');
    expect(store.read()).toBeNull();
  });
});
