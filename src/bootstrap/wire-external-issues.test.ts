import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../application/ports/command-runner.js';
import { wireExternalIssues } from './wire-external-issues.js';

describe('wireExternalIssues', () => {
  let root = '';
  afterEach(async () => { if (root !== '') await fs.rm(root, { recursive: true, force: true }); });

  it('stays disabled without a maintainer repo or a command runner', () => {
    const setTimer = vi.fn();
    const runner: CommandRunner = { run: vi.fn() };
    const disabled = wireExternalIssues({ repoRoot: '/tmp/no', env: {}, commandRunner: runner, isMaintainerEnvironment: () => false, timers: { setTimer, clearTimer: vi.fn() } });
    expect(disabled.enabled).toBe(false);
    expect(disabled.service).toBeUndefined();
    expect(setTimer).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(wireExternalIssues({ repoRoot: '/tmp/no', env: {}, isMaintainerEnvironment: () => true }).enabled).toBe(false);
  });

  it('enforces the GH call budget around the real source', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-issues-wire-'));
    await fs.mkdir(path.join(root, '.beads'));
    const timers: { callback: () => void; ms: number; unrefs: number }[] = [];
    const setTimer = vi.fn((callback: () => void, ms: number) => {
      const handle = { callback, ms, unrefs: 0, unref() { this.unrefs += 1; } };
      timers.push(handle);
      return handle;
    });
    const now = { value: 0 };
    const ghLine = JSON.stringify({ number: 7, title: 't', body: 'b', bodyLength: 1, updatedAt: '2026-10-05T00:00:00Z', author: 'someone', authorAssociation: 'NONE', pullRequest: false });
    const runner: CommandRunner = {
      run: vi.fn(async (command) => command === 'gh'
        ? { stdout: `${Array.from({ length: 100 }, () => ghLine).join('\n')}\n`, stderr: '', exitCode: 0 }
        : { stdout: '[]', stderr: '', exitCode: 0 }),
    };
    const wired = wireExternalIssues({
      repoRoot: root,
      env: {},
      commandRunner: runner,
      monotonicNow: () => now.value,
      isMaintainerEnvironment: () => true,
      timers: { setTimer, clearTimer: vi.fn() },
      log: vi.fn(),
    });
    expect(timers[0]?.ms).toBe(60_000);
    for (let attempt = 0; attempt < 5; attempt += 1) await wired.service!.poll();
    const ghRuns = (runner.run as ReturnType<typeof vi.fn>).mock.calls.filter(([command]) => command === 'gh');
    expect(ghRuns).toHaveLength(12);
    const failed = await wired.service!.poll();
    expect(failed).toMatchObject({ state: 'error', error: { kind: 'failed' } });
    expect(failed.error?.detail).toContain('gh call limit reached');
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.filter(([command]) => command === 'gh')).toHaveLength(12);
    now.value = 3_600_000;
    await wired.service!.poll();
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.filter(([command]) => command === 'gh')).toHaveLength(15);
    wired.stop();
  });
});
