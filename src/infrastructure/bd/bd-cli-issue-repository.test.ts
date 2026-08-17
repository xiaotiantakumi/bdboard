import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import type { Project } from '../../domain/project.js';
import { createBdCliIssueRepository } from './bd-cli-issue-repository.js';

const expectedListArgs = (rootPath: string): readonly string[] => [
  '--readonly',
  '-C',
  rootPath,
  'list',
  '--json',
  '--all',
  '--limit',
  '0',
  '--no-pager',
];

function minimalBdIssue(id: string) {
  return {
    id,
    title: `Issue ${id}`,
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: 'owner@example.com',
    created_at: '2026-08-14T08:00:00Z',
    created_by: 'Creator',
    updated_at: '2026-08-14T09:00:00Z',
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  };
}

function project(id: string, rootPath: string): Project {
  return { id, name: id, rootPath, prefixes: [], aliasPaths: [] };
}

interface FakeRunnerOptions {
  readonly handler?: (
    command: string,
    args: readonly string[],
  ) => Promise<CommandResult> | CommandResult;
  readonly delayMs?: number;
  readonly onRunStart?: () => void;
  readonly onRunEnd?: () => void;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{ command: string; args: readonly string[] }>;
  readonly maxConcurrent: { value: number };
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let active = 0;
  const maxConcurrent = { value: 0 };

  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      active += 1;
      maxConcurrent.value = Math.max(maxConcurrent.value, active);
      options.onRunStart?.();

      try {
        if (options.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        if (options.handler) {
          return await options.handler(command, args);
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      } finally {
        active -= 1;
        options.onRunEnd?.();
      }
    },
  };

  return { runner, calls, maxConcurrent };
}

describe('createBdCliIssueRepository', () => {
  it('maps fixture-like JSON from stdout into tickets', async () => {
    const issue = minimalBdIssue('proj-abc');
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([issue]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    const result = await repo.listTickets(project('proj', '/root/proj'));

    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]?.id).toBe('proj-abc');
    expect(result.project.prefixes).toEqual(['proj']);
  });

  it('succeeds when stderr has beads.role warning and exitCode is 0', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '[]',
        stderr: 'warning: beads.role not configured\n',
        exitCode: 0,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    const result = await repo.listTickets(project('empty', '/root/empty'));

    expect(result.tickets).toEqual([]);
    expect(result.project.prefixes).toEqual([]);
  });

  it('treats empty list as success', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '[]', stderr: '', exitCode: 0 }),
    });

    const repo = createBdCliIssueRepository(runner);
    const result = await repo.listTickets(project('pic', '/root/pic'));

    expect(result.tickets).toEqual([]);
  });

  it('classifies bd-not-found errors', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'bd: command not found',
        exitCode: 127,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    await expect(repo.listTickets(project('p', '/root'))).rejects.toMatchObject({
      kind: 'bd-not-found',
    } satisfies Partial<BdError>);
  });

  it('classifies not-a-beads-project errors', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'not a beads project',
        exitCode: 1,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    await expect(repo.listTickets(project('p', '/root'))).rejects.toMatchObject({
      kind: 'not-a-beads-project',
    } satisfies Partial<BdError>);
  });

  it('classifies lock-contention errors', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'database is locked',
        exitCode: 1,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    await expect(repo.listTickets(project('p', '/root'))).rejects.toMatchObject({
      kind: 'lock-contention',
    } satisfies Partial<BdError>);
  });

  it('classifies unknown errors', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'something unexpected happened',
        exitCode: 1,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    await expect(repo.listTickets(project('p', '/root'))).rejects.toMatchObject({
      kind: 'unknown',
    } satisfies Partial<BdError>);
  });

  it('classifies JSON parse failure as schema-mismatch', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: 'not json',
        stderr: '',
        exitCode: 0,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    await expect(repo.listTickets(project('p', '/root'))).rejects.toMatchObject({
      kind: 'schema-mismatch',
    } satisfies Partial<BdError>);
  });

  it('classifies schema validation failure as partial success with warnings', async () => {
    const valid = minimalBdIssue('proj-ok');
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([valid, { id: 'only-id' }]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    const result = await repo.listTickets(project('p', '/root'));

    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]?.id).toBe('proj-ok');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]?.kind).toBe('schema-mismatch');
    expect(result.warnings?.[0]?.detail).toContain('1件のチケットを読み飛ばしました');
  });

  it('returns remaining tickets and warnings when one JSON row is broken', async () => {
    const valid = minimalBdIssue('proj-ok');
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([valid, { id: 'broken-row' }]),
        stderr: '',
        exitCode: 0,
      }),
    });

    const repo = createBdCliIssueRepository(runner);
    const p = project('partial', '/root/partial');
    const listResult = await repo.listTickets(p);
    const { results, errors } = await repo.listAll([p]);

    expect(listResult.tickets).toHaveLength(1);
    expect(listResult.warnings).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('schema-mismatch');
    expect(results).toHaveLength(1);
    expect(results[0]?.tickets).toHaveLength(1);
  });

  it('passes the expected command and args including --readonly', async () => {
    const { runner, calls } = createFakeRunner();
    const repo = createBdCliIssueRepository(runner, { bdPath: '/usr/bin/bd' });

    await repo.listTickets(project('p', '/my/root'));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: '/usr/bin/bd',
      args: expectedListArgs('/my/root'),
    });
    expect(calls[0]?.args).toContain('--readonly');
  });

  it('limits listAll concurrency to the configured maximum', async () => {
    const projects = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      project(name, `/root/${name}`),
    );

    const { runner, maxConcurrent } = createFakeRunner({
      delayMs: 50,
      handler: async () => ({ stdout: '[]', stderr: '', exitCode: 0 }),
    });

    const repo = createBdCliIssueRepository(runner, { concurrency: 3 });
    await repo.listAll(projects);

    expect(maxConcurrent.value).toBeLessThanOrEqual(3);
    expect(maxConcurrent.value).toBeGreaterThan(1);
  });

  it('continues listAll when one project fails', async () => {
    const projects = [
      project('ok1', '/root/ok1'),
      project('fail', '/root/fail'),
      project('ok2', '/root/ok2'),
    ];

    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        const rootPath = args[2] ?? '';
        if (rootPath === '/root/fail') {
          return { stdout: '', stderr: 'not a beads project', exitCode: 1 };
        }
        return {
          stdout: JSON.stringify([minimalBdIssue(`${rootPath}-x`)]),
          stderr: '',
          exitCode: 0,
        };
      },
    });

    const repo = createBdCliIssueRepository(runner);
    const { results, errors } = await repo.listAll(projects);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('not-a-beads-project');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.project.rootPath)).toEqual(['/root/ok1', '/root/ok2']);
  });
});
