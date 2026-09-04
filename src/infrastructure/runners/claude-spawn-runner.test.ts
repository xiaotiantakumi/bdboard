import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRequest } from '../../application/ports/agent-runner.js';
import { DEFAULT_ALLOWED_TOOLS, DENIED_TOOLS } from './claude-runner.js';
import { createClaudeSpawnRunner } from './claude-spawn-runner.js';

const tempConfigDirs: string[] = [];

function makeTempClaudeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-claude-config-'));
  tempConfigDirs.push(dir);
  return dir;
}

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

const DEFAULT_WOULD_RUN_TOOLS = [
  ...DEFAULT_ALLOWED_TOOLS,
  'Read(//tmp/project/**)',
  'Edit(//tmp/project/**)',
  '--disallowedTools',
  ...DENIED_TOOLS,
].join(' ');

describe('createClaudeSpawnRunner', () => {
  afterEach(() => {
    for (const dir of tempConfigDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports spawn mode only', () => {
    const runner = createClaudeSpawnRunner({ claudeConfigDir: makeTempClaudeConfigDir() });
    expect(runner.supports(makeRequest({ mode: 'spawn' }))).toBe(true);
    expect(
      runner.supports(makeRequest({ mode: 'resume', sessionId: 's' })),
    ).toBe(false);
  });

  it('returns dispatch-disabled without executing', async () => {
    const runner = createClaudeSpawnRunner({ claudeConfigDir: makeTempClaudeConfigDir() });
    const outcome = await runner.dispatch(
      makeRequest({ mode: 'spawn', prompt: 'hello' }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('dispatch-disabled');
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.runner).toBe('claude-spawn');
    expect(outcome.error).toContain(
      `would run: claude -p --permission-mode default --allowedTools ${DEFAULT_WOULD_RUN_TOOLS} -- hello`,
    );
  });

  it('includes custom claudePath in the would-run message', async () => {
    const runner = createClaudeSpawnRunner({
      claudePath: '/opt/wrappers/claude',
      claudeConfigDir: makeTempClaudeConfigDir(),
    });
    const outcome = await runner.dispatch(makeRequest({ mode: 'spawn' }));

    expect(outcome.error).toContain(
      `would run: /opt/wrappers/claude --permission-mode default --allowedTools ${DEFAULT_WOULD_RUN_TOOLS}`,
    );
  });
});
