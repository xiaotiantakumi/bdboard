import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  PriorityConflictError,
  StatusConflictError,
} from '../../application/ports/issue-writer.js';
import { createBdCliIssueWriter } from './bd-cli-issue-writer.js';

const ROOT = '/root/proj';
const TICKET_ID = 'bdboard-3tw.13';

interface FakeRunnerOptions {
  readonly handler?: (
    command: string,
    args: readonly string[],
    options?: { cwd?: string },
  ) => Promise<CommandResult> | CommandResult;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    options?: { cwd?: string };
  }>;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    options?: { cwd?: string };
  }> = [];

  const runner: CommandRunner = {
    async run(command, args, runOptions) {
      calls.push({ command, args, options: runOptions });
      if (options.handler) {
        return await options.handler(command, args, runOptions);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createBdCliIssueWriter', () => {
  it('claims via bd_claim args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.claim(ROOT, TICKET_ID);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: ['-C', ROOT, 'update', TICKET_ID, '--claim'],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('closes with optional reason via bd_close args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.close(ROOT, TICKET_ID, 'done');

    expect(calls[0]?.args).toEqual([
      '-C',
      ROOT,
      'close',
      TICKET_ID,
      '-r',
      'done',
    ]);
  });

  it('defers via bd_defer args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.defer(ROOT, TICKET_ID, '2026-08-22');

    expect(calls[0]?.args).toEqual([
      '-C',
      ROOT,
      'update',
      TICKET_ID,
      '--defer',
      '2026-08-22',
    ]);
  });

  it('sets priority via bd_priority args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.setPriority(ROOT, TICKET_ID, 1);

    expect(calls[0]?.args).toEqual([
      '-C',
      ROOT,
      'update',
      TICKET_ID,
      '-p',
      '1',
    ]);
  });

  it('adds comment via bd_comment args with stdin', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.addComment(ROOT, TICKET_ID, 'progress update');

    expect(calls).toEqual([
      {
        command: 'bd',
        args: ['-C', ROOT, 'comment', TICKET_ID, '--stdin'],
        options: { cwd: ROOT, timeoutMs: 30_000, input: 'progress update' },
      },
    ]);
  });

  it('adds label via bd_label_add args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.addLabel(ROOT, TICKET_ID, 'human');

    expect(calls[0]?.args).toEqual([
      '-C',
      ROOT,
      'label',
      'add',
      TICKET_ID,
      'human',
    ]);
  });

  it('removes label via bd_label_remove args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.removeLabel(ROOT, TICKET_ID, 'gt:slot');

    expect(calls[0]?.args).toEqual([
      '-C',
      ROOT,
      'label',
      'remove',
      TICKET_ID,
      'gt:slot',
    ]);
  });

  it('reopens via bd reopen args after confirming the ticket is still closed (CAS success)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, status: 'closed' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.reopen(ROOT, TICKET_ID);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: [
          '--readonly',
          '-C',
          ROOT,
          'show',
          '--json',
          `--id=${TICKET_ID}`,
        ],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
      {
        command: 'bd',
        args: ['-C', ROOT, 'reopen', TICKET_ID],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  // bdboard-3tw.93: `bd reopen` is exit-0-and-no-op (not a non-zero exit) when the
  // ticket isn't currently closed, so a fake CAS check that only reacted to a
  // failing bd exit code would never trip here — this is the load-bearing check
  // that the CAS read-then-write actually gates the write on the real status.
  it('rejects with StatusConflictError and does not call bd reopen when the ticket is no longer closed (CAS mismatch)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, status: 'in_progress' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.reopen(ROOT, TICKET_ID)).rejects.toMatchObject({
      name: 'StatusConflictError',
      expectedStatus: 'closed',
      actualStatus: 'in_progress',
    });
    await expect(port.reopen(ROOT, TICKET_ID)).rejects.toBeInstanceOf(
      StatusConflictError,
    );

    // Only the read (bd show) call happened — bd reopen must never run once the
    // CAS check fails, or Undo would silently report success without reopening.
    expect(calls.every((call) => !call.args.includes('reopen'))).toBe(true);
  });

  it('throws BdError when the bd show read used for the reopen CAS check fails', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: 'not found', exitCode: 1 }),
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.reopen(ROOT, TICKET_ID)).rejects.toBeInstanceOf(
      BdError,
    );
  });

  it('unclaims via bd unclaim args', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await port.unclaim(ROOT, TICKET_ID);

    expect(calls).toEqual([
      {
        command: 'bd',
        args: ['-C', ROOT, 'unclaim', TICKET_ID],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('undefers via the dedicated bd undefer subcommand after confirming the ticket is still deferred (CAS success)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, status: 'deferred' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.undefer(ROOT, TICKET_ID);

    // bdboard-3tw.82: must use `bd undefer`, not `bd update --defer ''`.
    // bdboard-3tw.93: the dedicated subcommand's "not deferred" guard is
    // exit-0-and-no-op rather than an error, so the CAS read below is what
    // actually gates the write — not bd's own exit code.
    expect(calls).toEqual([
      {
        command: 'bd',
        args: [
          '--readonly',
          '-C',
          ROOT,
          'show',
          '--json',
          `--id=${TICKET_ID}`,
        ],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
      {
        command: 'bd',
        args: ['-C', ROOT, 'undefer', TICKET_ID],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('throws BdError when undefer exits non-zero after the CAS check passes', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, status: 'deferred' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'lock held', exitCode: 1 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.undefer(ROOT, TICKET_ID)).rejects.toBeInstanceOf(
      BdError,
    );
  });

  // bdboard-3tw.93: `bd undefer` is exit-0-and-no-op (not a non-zero exit) when
  // the ticket isn't currently deferred, so a fake CAS check that only reacted
  // to a failing bd exit code would never trip here — this is the load-bearing
  // check that the CAS read-then-write actually gates the write on the real
  // status.
  it('rejects with StatusConflictError and does not call bd undefer when the ticket is no longer deferred (CAS mismatch)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, status: 'closed' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.undefer(ROOT, TICKET_ID)).rejects.toMatchObject({
      name: 'StatusConflictError',
      expectedStatus: 'deferred',
      actualStatus: 'closed',
    });
    await expect(port.undefer(ROOT, TICKET_ID)).rejects.toBeInstanceOf(
      StatusConflictError,
    );

    // Only the read (bd show) call happened — bd undefer must never run once
    // the CAS check fails, or Undo would silently report success without
    // undeferring.
    expect(calls.every((call) => !call.args.includes('undefer'))).toBe(true);
  });

  it('throws BdError when the bd show read used for the undefer CAS check fails', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: 'not found', exitCode: 1 }),
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.undefer(ROOT, TICKET_ID)).rejects.toBeInstanceOf(
      BdError,
    );
  });

  it('retries the CAS bd show read on lock-contention before writing undefer (bdboard-3tj)', async () => {
    let showAttempts = 0;
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          showAttempts += 1;
          if (showAttempts === 1) {
            return { stdout: '', stderr: 'database is locked', exitCode: 1 };
          }
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, status: 'deferred' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.undefer(ROOT, TICKET_ID);

    // 2 回目の bd show でCASが通ってから undefer が1回だけ実行される
    expect(calls.filter((call) => call.args.includes('show'))).toHaveLength(2);
    expect(calls.filter((call) => call.args.includes('undefer'))).toHaveLength(1);
  });

  it('undoes priority by reading the current value first and writing back when it still matches (CAS success)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, priority: 1 }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.undoPriority(ROOT, TICKET_ID, 1, 3);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      '--readonly',
      '-C',
      ROOT,
      'show',
      '--json',
      `--id=${TICKET_ID}`,
    ]);
    expect(calls[1]?.args).toEqual(['-C', ROOT, 'update', TICKET_ID, '-p', '3']);
  });

  it('rejects with PriorityConflictError and does not write when the current priority has drifted (CAS mismatch)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, priority: 2 }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await expect(
      port.undoPriority(ROOT, TICKET_ID, 1, 3),
    ).rejects.toMatchObject({
      name: 'PriorityConflictError',
      expectedPriority: 1,
      actualPriority: 2,
    });
    await expect(port.undoPriority(ROOT, TICKET_ID, 1, 3)).rejects.toBeInstanceOf(
      PriorityConflictError,
    );

    // Only the read (bd show) call happened — the write must never run once
    // the CAS check fails, or Undo would silently clobber the other
    // session's change (the exact bug bdboard-3tw.82 fixes).
    expect(calls.every((call) => !call.args.includes('-p'))).toBe(true);
  });

  it('throws BdError when the bd show read used for the priority CAS check fails', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: '', stderr: 'not found', exitCode: 1 }),
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.undoPriority(ROOT, TICKET_ID, 1, 3)).rejects.toBeInstanceOf(
      BdError,
    );
  });

  it('throws BdError when the bd show output for the priority CAS check is unparseable', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: 'not json', stderr: '', exitCode: 0 }),
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.undoPriority(ROOT, TICKET_ID, 1, 3)).rejects.toBeInstanceOf(
      BdError,
    );
  });

  it('throws BdError when reopen exits non-zero after the CAS check passes', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, status: 'closed' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: 'lock held', exitCode: 1 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.reopen(ROOT, TICKET_ID)).rejects.toBeInstanceOf(BdError);
  });

  it('throws BdError when unclaim exits non-zero (e.g. assignee changed since claim)', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'issue is assigned to a different actor',
        exitCode: 1,
      }),
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.unclaim(ROOT, TICKET_ID)).rejects.toBeInstanceOf(BdError);
  });

  it('throws BdError when buildBdToolArgs rejects input', async () => {
    const { runner } = createFakeRunner();
    const port = createBdCliIssueWriter(runner);

    await expect(port.defer(ROOT, TICKET_ID, 'not-a-date')).rejects.toBeInstanceOf(
      BdError,
    );
  });

  it('throws BdError when bd exits non-zero', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'lock held',
        exitCode: 1,
      }),
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.claim(ROOT, TICKET_ID)).rejects.toMatchObject({
      kind: 'lock-contention',
    });
  });

  it('uses custom bdPath when provided', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner, { bdPath: '/usr/bin/bd' });

    await port.claim(ROOT, TICKET_ID);

    expect(calls[0]?.command).toBe('/usr/bin/bd');
  });
});
