import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileAgentRunConfigStore } from './agent-run-config-store.js';
import { createFileBoardThresholdsConfigStore } from './board-thresholds-config-store.js';
import { withConfigFileLock } from './config-file-write-lock.js';

describe('withConfigFileLock', () => {
  it('serializes concurrent operations on the same path', async () => {
    const events: string[] = [];
    const samePath = '/tmp/bdboard-config-lock-test-same';

    const run = (label: string, holdMs: number) =>
      withConfigFileLock(samePath, async () => {
        events.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        events.push(`${label}:end`);
      });

    await Promise.all([run('a', 30), run('b', 10), run('c', 5)]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('does not block concurrent operations on different paths', async () => {
    let blocked = false;
    let released = false;

    const gate = withConfigFileLock('/tmp/bdboard-config-lock-a', async () => {
      blocked = true;
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (released) {
            clearInterval(interval);
            resolve();
          }
        }, 5);
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(blocked).toBe(true);

    let parallelFinished = false;
    const parallel = withConfigFileLock('/tmp/bdboard-config-lock-b', async () => {
      parallelFinished = true;
    });

    await Promise.race([
      parallel.then(() => undefined),
      new Promise((_, reject) => setTimeout(() => reject(new Error('blocked')), 200)),
    ]);
    expect(parallelFinished).toBe(true);

    released = true;
    await gate;
  });
});

describe('config file write lock integration', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves both sections when two stores write the same config.json concurrently', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-config-lock-integration-'));
    const filePath = path.join(tmpDir, 'config.json');

    const agentRunStore = createFileAgentRunConfigStore(filePath);
    const boardThresholdsStore = createFileBoardThresholdsConfigStore(filePath);

    await Promise.all([
      agentRunStore.write({ allowRemoteAgentRuns: true }),
      boardThresholdsStore.write({ stalledAfterMs: 86_400_000 }),
    ]);

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({
      allowRemoteAgentRuns: true,
      stalledAfterMs: 86_400_000,
    });
  });
});
