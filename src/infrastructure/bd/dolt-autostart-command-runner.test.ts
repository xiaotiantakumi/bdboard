import { describe, expect, it } from 'vitest';
import type {
  CommandResult,
  CommandRunner,
} from '../../application/ports/command-runner.js';
import {
  createDoltAutostartCommandRunner,
  isDoltServerUnreachable,
} from './dolt-autostart-command-runner.js';

const UNREACHABLE: CommandResult = {
  stdout: '',
  stderr:
    'Error: failed to open database: dolt server unreachable at 127.0.0.1:3307: connection refused\ntry: bd dolt start',
  exitCode: 1,
};
const OK: CommandResult = { stdout: '[]', stderr: '', exitCode: 0 };
const READ_ARGS = ['--readonly', '-C', '/p/a', 'list', '--json'];

function scripted(readResults: CommandResult[]) {
  const calls: string[][] = [];
  const queue = [...readResults];
  const runner: CommandRunner = {
    async run(_command, args) {
      calls.push([...args]);
      if (args.includes('dolt')) {
        return OK;
      }
      return queue.shift() ?? OK;
    },
  };
  return { runner, calls };
}

describe('isDoltServerUnreachable', () => {
  it('matches unreachable failures only', () => {
    expect(isDoltServerUnreachable(UNREACHABLE)).toBe(true);
    expect(isDoltServerUnreachable(OK)).toBe(false);
    expect(
      isDoltServerUnreachable({ stdout: '', stderr: 'boom', exitCode: 1 }),
    ).toBe(false);
  });
});

describe('createDoltAutostartCommandRunner', () => {
  it('starts dolt then retries once, hiding the error on success', async () => {
    const { runner, calls } = scripted([UNREACHABLE, OK]);
    const wrapped = createDoltAutostartCommandRunner(runner);
    const result = await wrapped.run('bd', READ_ARGS);
    expect(result).toEqual(OK);
    expect(calls).toEqual([
      READ_ARGS,
      ['-C', '/p/a', 'dolt', 'start'],
      READ_ARGS,
    ]);
  });

  it('does not start again during the cooldown', async () => {
    const { runner, calls } = scripted([
      UNREACHABLE,
      UNREACHABLE,
      UNREACHABLE,
      UNREACHABLE,
      UNREACHABLE,
    ]);
    let t = 0;
    const wrapped = createDoltAutostartCommandRunner(runner, {
      cooldownMs: 60_000,
      now: () => t,
    });
    await wrapped.run('bd', READ_ARGS);
    t = 10_000;
    const second = await wrapped.run('bd', READ_ARGS);
    expect(second).toEqual(UNREACHABLE);
    expect(calls.filter((a) => a.includes('dolt'))).toHaveLength(1);
    t = 70_000;
    await wrapped.run('bd', READ_ARGS);
    expect(calls.filter((a) => a.includes('dolt'))).toHaveLength(2);
  });

  it('keeps the error when the retry also fails', async () => {
    const { runner } = scripted([UNREACHABLE, UNREACHABLE]);
    const wrapped = createDoltAutostartCommandRunner(runner);
    expect(await wrapped.run('bd', READ_ARGS)).toEqual(UNREACHABLE);
  });

  it('ignores non-readonly calls and other failures', async () => {
    const { runner, calls } = scripted([UNREACHABLE]);
    const wrapped = createDoltAutostartCommandRunner(runner);
    await wrapped.run('bd', ['-C', '/p/a', 'close', 'x']);
    expect(calls).toHaveLength(1);
  });

  it('only starts for projects the gate allows, without burning the cooldown', async () => {
    const { runner, calls } = scripted([UNREACHABLE, UNREACHABLE, UNREACHABLE]);
    let allowed = false;
    const wrapped = createDoltAutostartCommandRunner(runner, {
      shouldStart: () => allowed,
    });
    expect(await wrapped.run('bd', READ_ARGS)).toEqual(UNREACHABLE);
    expect(calls.filter((a) => a.includes('dolt'))).toHaveLength(0);
    allowed = true;
    await wrapped.run('bd', READ_ARGS);
    expect(calls.filter((a) => a.includes('dolt'))).toHaveLength(1);
  });

  it('single-flights concurrent starts per project', async () => {
    const calls: string[][] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen = new Map<string, number>();
    const runner: CommandRunner = {
      async run(_c, args) {
        calls.push([...args]);
        if (args.includes('dolt')) {
          await gate;
          return OK;
        }
        const n = (seen.get(args.join(' ')) ?? 0) + 1;
        seen.set(args.join(' '), n);
        return n === 1 ? UNREACHABLE : OK;
      },
    };
    const wrapped = createDoltAutostartCommandRunner(runner);
    const a = wrapped.run('bd', READ_ARGS);
    const b = wrapped.run('bd', READ_ARGS);
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await Promise.all([a, b])).toEqual([OK, OK]);
    expect(calls.filter((x) => x.includes('dolt'))).toHaveLength(1);
  });
});
