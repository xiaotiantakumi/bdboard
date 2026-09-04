import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRequest } from '../../application/ports/agent-runner.js';
import { DEFAULT_ALLOWED_TOOLS, DENIED_TOOLS } from './claude-runner.js';
import { createClaudeResumeRunner } from './claude-resume-runner.js';

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
    mode: 'resume',
    sessionId: 'sess-1',
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

describe('createClaudeResumeRunner', () => {
  afterEach(() => {
    for (const dir of tempConfigDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports resume mode only', () => {
    const runner = createClaudeResumeRunner({ claudeConfigDir: makeTempClaudeConfigDir() });
    expect(runner.supports(makeRequest({ mode: 'resume', sessionId: 's' }))).toBe(
      true,
    );
    expect(runner.supports(makeRequest({ mode: 'spawn' }))).toBe(false);
  });

  it('returns dispatch-disabled without executing', async () => {
    const runner = createClaudeResumeRunner({ claudeConfigDir: makeTempClaudeConfigDir() });
    const outcome = await runner.dispatch(
      makeRequest({ mode: 'resume', sessionId: 'sess-1', prompt: 'continue' }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('dispatch-disabled');
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.runner).toBe('claude-resume');
    expect(outcome.run.sessionId).toBe('sess-1');
    expect(outcome.error).toContain(
      `would run: claude --resume sess-1 --permission-mode default --allowedTools ${DEFAULT_WOULD_RUN_TOOLS} -- continue`,
    );
  });

  it('reports invalid-request instead of throwing when resume has no sessionId', async () => {
    const runner = createClaudeResumeRunner({ claudeConfigDir: makeTempClaudeConfigDir() });
    const outcome = await runner.dispatch(
      makeRequest({ mode: 'resume', sessionId: undefined }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('invalid-request');
    // Must never degrade into a fresh-spawn command.
    expect(outcome.error).not.toContain('would run');
  });

  it('includes custom claudePath in the would-run message', async () => {
    const runner = createClaudeResumeRunner({
      claudePath: '/opt/wrappers/claude',
      claudeConfigDir: makeTempClaudeConfigDir(),
    });
    const outcome = await runner.dispatch(
      makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
    );

    expect(outcome.error).toContain(
      `would run: /opt/wrappers/claude --resume sess-1 --permission-mode default --allowedTools ${DEFAULT_WOULD_RUN_TOOLS}`,
    );
  });
});
