import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createBdCliSessionLinkReader } from './bd-cli-session-link-reader.js';

const ROOT = '/root/proj';
const TICKET_ID = 'bdboard-3tw.67';

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
      return { stdout: '[]', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createBdCliSessionLinkReader', () => {
  it('reads manual session link and models via a single bd show --json', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([
          {
            id: TICKET_ID,
            metadata: {
              'bdboard.session': 'example-session-uuid',
              'bdboard.model.implement': 'composer-2.5',
              'bdboard.model.test': 'opus',
            },
          },
        ]),
        stderr: '',
        exitCode: 0,
      }),
    });
    const port = createBdCliSessionLinkReader(runner);

    const result = await port.readTicketMetadata(ROOT, TICKET_ID);

    expect(result).toEqual({
      manualSessionId: 'example-session-uuid',
      models: [
        { stage: 'implement', model: 'composer-2.5' },
        { stage: 'test', model: 'opus' },
      ],
    });
    expect(calls).toEqual([
      {
        command: 'bd',
        args: ['--readonly', '-C', ROOT, 'show', '--json', `--id=${TICKET_ID}`],
        options: { cwd: ROOT, timeoutMs: 30_000 },
      },
    ]);
  });

  it('invokes commandRunner.run exactly once per readTicketMetadata call', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([{ id: TICKET_ID }]),
        stderr: '',
        exitCode: 0,
      }),
    });
    const runSpy = vi.spyOn(runner, 'run');
    const port = createBdCliSessionLinkReader(runner);

    await port.readTicketMetadata(ROOT, TICKET_ID);

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('returns empty models when metadata has no bdboard.session or model keys', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([{ id: TICKET_ID, metadata: { other: 'x' } }]),
        stderr: '',
        exitCode: 0,
      }),
    });
    const port = createBdCliSessionLinkReader(runner);

    expect(await port.readTicketMetadata(ROOT, TICKET_ID)).toEqual({
      models: [],
    });
  });

  it('returns empty models when the ticket has no metadata at all', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify([{ id: TICKET_ID }]),
        stderr: '',
        exitCode: 0,
      }),
    });
    const port = createBdCliSessionLinkReader(runner);

    expect(await port.readTicketMetadata(ROOT, TICKET_ID)).toEqual({
      models: [],
    });
  });

  it('degrades to { models: [] } when bd exits non-zero (e.g. ticket not found)', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '{"error":"no issues found matching the provided IDs"}',
        stderr: '',
        exitCode: 1,
      }),
    });
    const port = createBdCliSessionLinkReader(runner);

    expect(await port.readTicketMetadata(ROOT, TICKET_ID)).toEqual({
      models: [],
    });
  });

  it('degrades to { models: [] } when stdout is not valid JSON', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({ stdout: 'not json', stderr: '', exitCode: 0 }),
    });
    const port = createBdCliSessionLinkReader(runner);

    expect(await port.readTicketMetadata(ROOT, TICKET_ID)).toEqual({
      models: [],
    });
  });

  it('rejects an invalid ticket id without invoking the runner', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliSessionLinkReader(runner);

    expect(await port.readTicketMetadata(ROOT, '-rf')).toEqual({ models: [] });
    expect(calls).toHaveLength(0);
  });

  it('uses custom bdPath when provided', async () => {
    const { runner, calls } = createFakeRunner();
    const port = createBdCliSessionLinkReader(runner, {
      bdPath: '/usr/bin/bd',
    });

    await port.readTicketMetadata(ROOT, TICKET_ID);

    expect(calls[0]?.command).toBe('/usr/bin/bd');
  });
});
