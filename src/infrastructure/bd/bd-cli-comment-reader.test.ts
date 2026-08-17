import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { createBdCliCommentReader } from './bd-cli-comment-reader.js';

const expectedCommentsArgs = (
  rootPath: string,
  issueId: string,
): readonly string[] => [
  '--readonly',
  '-C',
  rootPath,
  'comments',
  issueId,
  '--json',
];

function minimalBdComment(id: string, issueId: string) {
  return {
    id,
    issue_id: issueId,
    author: 'Takumi Oda',
    text: '本文',
    created_at: '2026-08-14T17:57:18Z',
  };
}

interface FakeRunnerOptions {
  readonly handler?: (
    command: string,
    args: readonly string[],
  ) => Promise<CommandResult> | CommandResult;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{ command: string; args: readonly string[] }>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];

  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (options.handler) {
        return await options.handler(command, args);
      }
      return { stdout: '[]', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createBdCliCommentReader', () => {
  it('maps fixture-like JSON from stdout into comments sorted by createdAt', async () => {
    const issueId = 'bdboard-3tw.27';
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          minimalBdComment('comment-2', issueId),
          {
            ...minimalBdComment('comment-1', issueId),
            created_at: '2026-08-14T10:00:00Z',
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createBdCliCommentReader(runner);
    const comments = await reader.listComments('/root/proj', issueId);

    expect(comments).toHaveLength(2);
    expect(comments[0]?.id).toBe('comment-1');
    expect(comments[1]?.id).toBe('comment-2');
    expect(comments[0]?.author).toBe('Takumi Oda');
    expect(comments[0]?.text).toBe('本文');
    expect(comments[0]?.issueId).toBe(issueId);
    expect(comments[0]?.createdAt).toEqual(new Date('2026-08-14T10:00:00Z'));
  });

  it('treats empty stdout as an empty list', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    });

    const reader = createBdCliCommentReader(runner);
    const comments = await reader.listComments('/root/proj', 'bdboard-abc');

    expect(comments).toEqual([]);
  });

  it('treats invalid JSON as an empty list', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: 'not json',
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createBdCliCommentReader(runner);
    const comments = await reader.listComments('/root/proj', 'bdboard-abc');

    expect(comments).toEqual([]);
  });

  it('treats schema validation failure as an empty list', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([{ id: 'only-id' }]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const reader = createBdCliCommentReader(runner);
    const comments = await reader.listComments('/root/proj', 'bdboard-abc');

    expect(comments).toEqual([]);
  });

  it('throws BdError when bd exits with failure', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'database is locked',
        exitCode: 1,
      }),
    });

    const reader = createBdCliCommentReader(runner);
    await expect(
      reader.listComments('/root/proj', 'bdboard-abc'),
    ).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
  });

  it('passes the expected command and args including --readonly', async () => {
    const issueId = 'bdboard-3tw.27';
    const { runner, calls } = createFakeRunner();
    const reader = createBdCliCommentReader(runner, { bdPath: '/usr/bin/bd' });

    await reader.listComments('/my/root', issueId);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: '/usr/bin/bd',
      args: expectedCommentsArgs('/my/root', issueId),
    });
    expect(calls[0]?.args).toContain('--readonly');
  });
});
