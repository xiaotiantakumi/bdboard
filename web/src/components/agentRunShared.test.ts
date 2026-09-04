import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { describeRunStartError } from './agentRunShared';

describe('describeRunStartError', () => {
  it('maps worktree-dirty to a Japanese remediation message', () => {
    const message = describeRunStartError(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
          reason: 'worktree-dirty',
        },
      ),
    );

    expect(message).toMatch(/未コミットの変更があるため実行できません/);
    expect(message).toContain('/tmp/worktrees/bdboard-abc.1');
  });

  it('maps too many concurrent runs to a Japanese remediation message', () => {
    const message = describeRunStartError(
      new ApiError(429, 'too many concurrent runs', {
        errorMessage: 'too many concurrent runs',
      }),
    );

    expect(message).toBe(
      '同時に実行できる上限に達しています。実行中のものが終わってからお試しください。',
    );
  });
});
