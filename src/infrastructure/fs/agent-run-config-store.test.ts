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
import { createFileAgentRunConfigStore } from './agent-run-config-store.js';

describe('createFileAgentRunConfigStore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePath(): string {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-agent-run-'));
    return path.join(tmpDir, 'nested', 'config.json');
  }

  it('returns undefined when absent', async () => {
    expect(await createFileAgentRunConfigStore(makePath()).read()).toBeUndefined();
  });

  it('round-trips a config and writes pretty JSON', async () => {
    const filePath = makePath();
    const store = createFileAgentRunConfigStore(filePath);
    const config = { allowRemoteAgentRuns: true } as const;
    await store.write(config);
    expect(await store.read()).toEqual(config);
    expect(readFileSync(filePath, 'utf8')).toContain('\n  "allowRemoteAgentRuns"');
  });

  it('ignores invalid values while keeping valid ones', async () => {
    const filePath = makePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        allowRemoteAgentRuns: 'bad',
        stalledAfterMs: 86_400_000,
      }),
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await createFileAgentRunConfigStore(filePath).read()).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves other keys when writing agent run config to the same file', async () => {
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

    await createFileAgentRunConfigStore(filePath).write({ allowRemoteAgentRuns: true });

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      scanRoots: ['/keep-me'],
      stalledAfterMs: 86_400_000,
      allowRemoteAgentRuns: true,
    });
  });

  it('does not leave a temp file behind after a write (atomic rename)', async () => {
    const filePath = makePath();
    await createFileAgentRunConfigStore(filePath).write({ allowRemoteAgentRuns: false });

    expect(readdirSync(path.dirname(filePath))).toEqual(['config.json']);
  });
});
