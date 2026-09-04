import { describe, expect, it } from 'vitest';
import type { RunRequest } from '../ports/agent-runner.js';
import {
  validateProvisionedRunCwd,
  validateRunRequest,
} from './validate-run-request.js';

// `cwd: '/tmp/project'` は provision 前の要求を表す。worktree 配下への cwd 制約は
// `validateRunRequest` の責務ではなく、provision 後の `validateProvisionedRunCwd`
// が runner へ渡す直前の境界で担う。
function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

describe('validateRunRequest', () => {
  it('returns null for a valid spawn request', () => {
    expect(validateRunRequest(makeRequest({ mode: 'spawn' }))).toBeNull();
  });

  it('returns null for a valid resume request with sessionId', () => {
    expect(
      validateRunRequest(
        makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
      ),
    ).toBeNull();
  });

  it('rejects resume without sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume' })),
    ).toBe('invalid-request');
  });

  it('rejects resume with empty sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume', sessionId: '' })),
    ).toBe('invalid-request');
  });

  it('rejects resume with whitespace-only sessionId', () => {
    expect(
      validateRunRequest(makeRequest({ mode: 'resume', sessionId: '   ' })),
    ).toBe('invalid-request');
  });

  it('rejects empty cwd', () => {
    expect(validateRunRequest(makeRequest({ cwd: '' }))).toBe('invalid-request');
  });

  it('rejects whitespace-only cwd', () => {
    expect(validateRunRequest(makeRequest({ cwd: '  ' }))).toBe(
      'invalid-request',
    );
  });

  it('rejects empty ticketId', () => {
    expect(validateRunRequest(makeRequest({ ticketId: '' }))).toBe(
      'invalid-request',
    );
  });

  it('rejects whitespace-only ticketId', () => {
    expect(validateRunRequest(makeRequest({ ticketId: '  ' }))).toBe(
      'invalid-request',
    );
  });
});

describe('validateProvisionedRunCwd', () => {
  it('returns null for a valid managed worktree path', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBeNull();
  });

  it('returns null for a ticket id containing dots', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-3tw.65',
        '/repo/.claude/worktrees/bdboard-3tw.65',
        'bdboard-3tw.65',
        '/repo',
      ),
    ).toBeNull();
  });

  it('returns null when cwd and worktreePath differ only by trailing slashes', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1/',
        '/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBeNull();
  });

  it('returns invalid-request when worktreePath is not under .claude/worktrees', () => {
    expect(
      validateProvisionedRunCwd('/tmp/project', '/tmp/project', 'bdboard-1', '/repo'),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when worktree basename does not match ticketId', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/other-ticket',
        '/repo/.claude/worktrees/other-ticket',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when parent is not .claude/worktrees', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/other/bdboard-1',
        '/repo/.claude/other/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when cwd does not match worktreePath', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-2',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when worktreePath is empty', () => {
    expect(
      validateProvisionedRunCwd('/repo/.claude/worktrees/bdboard-1', '', 'bdboard-1', '/repo'),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when ticketId is empty', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-1',
        '',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('rejects a worktree path under a different repository root', () => {
    expect(
      validateProvisionedRunCwd(
        '/other/repo/.claude/worktrees/bdboard-1',
        '/other/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '/repo',
      ),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when ticketId traverses out of the worktrees directory', () => {
    // path.join(repoRoot, '.claude', 'worktrees', '..') normalizes to '<repoRoot>/.claude',
    // so without the basename-drift guard this path would be accepted.
    expect(
      validateProvisionedRunCwd('/repo/.claude', '/repo/.claude', '..', '/repo'),
    ).toBe('invalid-request');
  });

  it('returns invalid-request when repoRoot is empty', () => {
    expect(
      validateProvisionedRunCwd(
        '/repo/.claude/worktrees/bdboard-1',
        '/repo/.claude/worktrees/bdboard-1',
        'bdboard-1',
        '',
      ),
    ).toBe('invalid-request');
  });
});
