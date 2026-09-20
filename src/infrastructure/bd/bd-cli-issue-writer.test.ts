import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { BdError } from '../../application/ports/issue-repository.js';
import {
  ContentConflictError,
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

  // bdboard-miqg: claim は同一アクターの再実行が真の no-op (bdboard-pkr6.26 実測、
  // 上の「別アクター保持中」テストの直前のコメント参照) であることが分かっている
  // ため、一時的な .beads lock-contention に限り自動リトライする
  // (bd-cli-session-link-writer.test.ts の同名テストと同じ形)。
  it('retries claim once on lock-contention and succeeds on the second attempt (bdboard-miqg)', async () => {
    let attempts = 0;
    const { runner, calls } = createFakeRunner({
      handler: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { stdout: '', stderr: 'error: database is locked', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.claim(ROOT, TICKET_ID);

    expect(calls).toHaveLength(2);
  });

  // bdboard-pkr6.26 実測 (bd 1.x, 2026-09-19): 使い捨てチケットで
  // 1) 同一アクターの再 claim -> exit 0, revision すら変わらない真の no-op
  //    (reopen/undefer (bdboard-3tw.93) の「前提を満たさなくても no-op」パターンとは
  //    別物 — claim には元々そのパターンが無いことを確認した)
  // 2) 別アクター(--actor で偽装)が既に in_progress のチケットへ claim -> exit 1,
  //    stderr "Error updating <id>: issue already claimed by <assignee>"
  // ここでは 2) の文言をそのまま流し込み、"already claimed" は lock-contention の
  // パターン(/\block\w*\b/)に一致しないため BdError.kind='unknown' で失敗することを
  // 固定する。呼び出し元 (agent-run-routes.ts の run-start claim) は kind を問わず
  // 「claim が例外を投げたら run を開始しない」という判定しかしていないため、これは
  // その判定の前提が実測と食い違っていないことの裏取り。
  it('throws BdError (kind: unknown) when claim fails because another actor already holds it', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: `Error updating ${TICKET_ID}: issue already claimed by Takumi Oda\n`,
        exitCode: 1,
      }),
    });
    const port = createBdCliIssueWriter(runner);

    await expect(port.claim(ROOT, TICKET_ID)).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  it('uses custom bdPath when provided', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliIssueWriter(runner, { bdPath: '/usr/bin/bd' });

    await port.claim(ROOT, TICKET_ID);

    expect(calls[0]?.command).toBe('/usr/bin/bd');
  });

  it('updates title by reading the current value first and writing when it still matches (CAS success)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, title: 'Old title' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.updateTitle(ROOT, TICKET_ID, 'New title', 'Old title');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      '--readonly',
      '-C',
      ROOT,
      'show',
      '--json',
      `--id=${TICKET_ID}`,
    ]);
    expect(calls[1]?.args).toEqual([
      '-C',
      ROOT,
      'update',
      TICKET_ID,
      '--title',
      'New title',
    ]);
  });

  it('rejects with ContentConflictError and does not write when the current title has drifted (CAS mismatch)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID, title: 'Changed title' }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await expect(
      port.updateTitle(ROOT, TICKET_ID, 'New title', 'Old title'),
    ).rejects.toMatchObject({
      name: 'ContentConflictError',
      field: 'title',
      expectedValue: 'Old title',
      actualValue: 'Changed title',
    });
    await expect(
      port.updateTitle(ROOT, TICKET_ID, 'New title', 'Old title'),
    ).rejects.toBeInstanceOf(ContentConflictError);

    expect(calls.every((call) => !call.args.includes('--title'))).toBe(true);
  });

  it('updates description by reading the current value first and writing when it still matches (CAS success)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              { id: TICKET_ID, description: 'Old description' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.updateDescription(
      ROOT,
      TICKET_ID,
      'New description',
      'Old description',
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      '--readonly',
      '-C',
      ROOT,
      'show',
      '--json',
      `--id=${TICKET_ID}`,
    ]);
    expect(calls[1]?.args).toEqual([
      '-C',
      ROOT,
      'update',
      TICKET_ID,
      '--stdin',
    ]);
  });

  it('treats missing description as empty string for CAS comparison', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([{ id: TICKET_ID }]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await port.updateDescription(ROOT, TICKET_ID, 'New description', '');

    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual([
      '-C',
      ROOT,
      'update',
      TICKET_ID,
      '--stdin',
    ]);
  });

  it('rejects with ContentConflictError and does not write when the current description has drifted (CAS mismatch)', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args.includes('show')) {
          return {
            stdout: JSON.stringify([
              { id: TICKET_ID, description: 'Changed description' },
            ]),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const port = createBdCliIssueWriter(runner);

    await expect(
      port.updateDescription(
        ROOT,
        TICKET_ID,
        'New description',
        'Old description',
      ),
    ).rejects.toMatchObject({
      name: 'ContentConflictError',
      field: 'description',
      expectedValue: 'Old description',
      actualValue: 'Changed description',
    });
    await expect(
      port.updateDescription(
        ROOT,
        TICKET_ID,
        'New description',
        'Old description',
      ),
    ).rejects.toBeInstanceOf(ContentConflictError);

    expect(calls.every((call) => !call.args.includes('--stdin'))).toBe(true);
  });

  // bdboard-p5l.25: ハーネス契約チケットの起票 (findOpenTicketByLabel / create).
  describe('findOpenTicketByLabel', () => {
    it('returns null when bd list finds no open ticket for the label', async () => {
      const { runner, calls } = createFakeRunner({
        handler: async () => ({ stdout: '[]', stderr: '', exitCode: 0 }),
      });
      const port = createBdCliIssueWriter(runner);

      const result = await port.findOpenTicketByLabel?.(ROOT, 'harness-contract');

      expect(result).toBeNull();
      expect(calls).toEqual([
        {
          command: 'bd',
          args: [
            '--readonly',
            '-C',
            ROOT,
            'list',
            '--label',
            'harness-contract',
            '--json',
            '--limit',
            '0',
            '--no-pager',
          ],
          options: { cwd: ROOT, timeoutMs: 30_000 },
        },
      ]);
    });

    it('returns the first open ticket id/title when bd list finds a match', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify([
            { id: 'proj-42', title: 'existing harness-contract ticket' },
            { id: 'proj-43', title: 'a second match, ignored' },
          ]),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      const result = await port.findOpenTicketByLabel?.(ROOT, 'harness-contract');

      expect(result).toEqual({
        id: 'proj-42',
        title: 'existing harness-contract ticket',
        metadata: {},
      });
    });

    // bdboard-13mp: state 遷移をまたいだ陳腐化チケットの扱いを、起票時/最後に
    // 追記した state を記録した bd メタデータの読み取りで判別する。
    it('surfaces metadata from bd list output for the state-change comparison (bdboard-13mp)', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify([
            {
              id: 'proj-42',
              title: 'existing harness-contract ticket',
              metadata: { 'bdboard.harness_contract.state': 'invalid' },
            },
          ]),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      const result = await port.findOpenTicketByLabel?.(ROOT, 'harness-contract');

      expect(result).toEqual({
        id: 'proj-42',
        title: 'existing harness-contract ticket',
        metadata: { 'bdboard.harness_contract.state': 'invalid' },
      });
    });

    it('throws BdError (does not silently treat it as "no ticket") when bd list output is not an array', async () => {
      // Load-bearing for idempotency: a non-array/unexpected shape must not be
      // treated the same as "no open ticket found", or a parse-shape drift in
      // `bd` would silently start creating duplicate tickets on every click.
      const { runner } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify({ unexpected: 'shape' }),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      await expect(
        port.findOpenTicketByLabel?.(ROOT, 'harness-contract'),
      ).rejects.toBeInstanceOf(BdError);
    });

    it('throws BdError when bd list output is not valid JSON', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({ stdout: 'not json', stderr: '', exitCode: 0 }),
      });
      const port = createBdCliIssueWriter(runner);

      await expect(
        port.findOpenTicketByLabel?.(ROOT, 'harness-contract'),
      ).rejects.toBeInstanceOf(BdError);
    });

    it('throws BdError when a matched item is missing id/title', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify([{ id: 'proj-42' }]),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      await expect(
        port.findOpenTicketByLabel?.(ROOT, 'harness-contract'),
      ).rejects.toBeInstanceOf(BdError);
    });
  });

  describe('create', () => {
    const CREATE_INPUT = {
      title: 'ハーネス: 検証コントラクトを作成する',
      description: 'line1\nline2',
      type: 'task',
      priority: 2,
      labels: ['harness-contract'],
    };

    it('builds create args with title/type/priority/labels and passes the description via stdin', async () => {
      const { runner, calls } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify({ id: 'proj-42' }),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      const result = await port.create?.(ROOT, CREATE_INPUT);

      expect(result).toEqual({ id: 'proj-42' });
      expect(calls).toEqual([
        {
          command: 'bd',
          args: [
            '-C',
            ROOT,
            'create',
            '--title',
            CREATE_INPUT.title,
            '--type',
            'task',
            '--priority',
            '2',
            '--json',
            '--labels',
            'harness-contract',
            '--stdin',
          ],
          options: { cwd: ROOT, timeoutMs: 30_000, input: CREATE_INPUT.description },
        },
      ]);
    });

    it('omits --labels when no labels are given', async () => {
      const { runner, calls } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify({ id: 'proj-1' }),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      await port.create?.(ROOT, { ...CREATE_INPUT, labels: [] });

      expect(calls[0]?.args).not.toContain('--labels');
    });

    it('parses a create result wrapped in a JSON array', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify([{ id: 'proj-99' }]),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      const result = await port.create?.(ROOT, CREATE_INPUT);

      expect(result).toEqual({ id: 'proj-99' });
    });

    it('throws BdError when bd create exits non-zero (no retry for a non-idempotent write)', async () => {
      const { runner, calls } = createFakeRunner({
        handler: async () => ({ stdout: '', stderr: 'database is locked', exitCode: 1 }),
      });
      const port = createBdCliIssueWriter(runner);

      await expect(port.create?.(ROOT, CREATE_INPUT)).rejects.toBeInstanceOf(BdError);
      // A non-idempotent write must not be retried, or we risk creating a
      // duplicate ticket on lock contention.
      expect(calls).toHaveLength(1);
    });

    it('throws BdError when bd create output is not valid JSON', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({ stdout: 'not json', stderr: '', exitCode: 0 }),
      });
      const port = createBdCliIssueWriter(runner);

      await expect(port.create?.(ROOT, CREATE_INPUT)).rejects.toBeInstanceOf(BdError);
    });

    it('throws BdError when bd create output is missing an id', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({ stdout: JSON.stringify({}), stderr: '', exitCode: 0 }),
      });
      const port = createBdCliIssueWriter(runner);

      await expect(port.create?.(ROOT, CREATE_INPUT)).rejects.toBeInstanceOf(BdError);
    });

    // bdboard-13mp: 起票と同時に state を記録できるかを実測で確認した
    // (`bd create --metadata '<json>'` は作成時点で set できる) 挙動の固定。
    it('passes --metadata as a JSON string when metadata is given', async () => {
      const { runner, calls } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify({ id: 'proj-42' }),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      await port.create?.(ROOT, {
        ...CREATE_INPUT,
        metadata: { 'bdboard.harness_contract.state': 'missing' },
      });

      expect(calls[0]?.args).toContain('--metadata');
      const metadataIndex = calls[0]?.args.indexOf('--metadata') ?? -1;
      expect(calls[0]?.args[metadataIndex + 1]).toBe(
        JSON.stringify({ 'bdboard.harness_contract.state': 'missing' }),
      );
    });

    it('omits --metadata when metadata is not given or empty', async () => {
      const { runner, calls } = createFakeRunner({
        handler: async () => ({
          stdout: JSON.stringify({ id: 'proj-42' }),
          stderr: '',
          exitCode: 0,
        }),
      });
      const port = createBdCliIssueWriter(runner);

      await port.create?.(ROOT, CREATE_INPUT);
      await port.create?.(ROOT, { ...CREATE_INPUT, metadata: {} });

      expect(calls[0]?.args).not.toContain('--metadata');
      expect(calls[1]?.args).not.toContain('--metadata');
    });
  });

  // bdboard-13mp: 既存のハーネス契約チケットへ state 変化を追記する際に使う
  // `bd update --set-metadata` の直叩き。
  describe('setMetadata', () => {
    it('builds a bd update --set-metadata command', async () => {
      const { runner, calls } = createFakeRunner({
        handler: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      });
      const port = createBdCliIssueWriter(runner);

      await port.setMetadata?.(
        ROOT,
        TICKET_ID,
        'bdboard.harness_contract.state',
        'invalid',
      );

      expect(calls).toEqual([
        {
          command: 'bd',
          args: [
            '-C',
            ROOT,
            'update',
            TICKET_ID,
            '--set-metadata',
            'bdboard.harness_contract.state=invalid',
          ],
          options: { cwd: ROOT, timeoutMs: 30_000 },
        },
      ]);
    });

    it('throws BdError when bd update exits non-zero', async () => {
      const { runner } = createFakeRunner({
        handler: async () => ({ stdout: '', stderr: 'boom', exitCode: 1 }),
      });
      const port = createBdCliIssueWriter(runner);

      await expect(
        port.setMetadata?.(ROOT, TICKET_ID, 'k', 'v'),
      ).rejects.toBeInstanceOf(BdError);
    });

    // --set-metadata は代入操作 (同じ引数で複数回実行しても最終状態は変わらない) なので
    // lock-contention に限りリトライしてよい (create とは対照的 — create は非冪等)。
    it('retries once on lock-contention and succeeds on the second attempt', async () => {
      let attempts = 0;
      const { runner, calls } = createFakeRunner({
        handler: async () => {
          attempts += 1;
          if (attempts === 1) {
            return { stdout: '', stderr: 'error: database is locked', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
      const port = createBdCliIssueWriter(runner);

      await port.setMetadata?.(ROOT, TICKET_ID, 'k', 'v');

      expect(calls).toHaveLength(2);
    });
  });
});
