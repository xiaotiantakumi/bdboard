import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createPsProcessScanner } from './ps-process-scanner.js';

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
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

const PS_LINE_CLAUDE =
  '  100 Thu Aug 14 09:12:33 2026 /usr/local/bin/claude --dangerously-skip-permissions';
const PS_LINE_CURSOR =
  '  200 Thu Aug 14 10:00:00 2026 /Users/dev/.local/bin/cursor-agent run';
const PS_LINE_NODE_WRAPPER =
  '  300 Thu Aug 14 10:01:00 2026 node /Users/dev/.npm-global/bin/codex';
const PS_LINE_NODE_ONLY =
  '  400 Thu Aug 14 10:02:00 2026 node /Users/dev/project/server.js';
const PS_LINE_APPS =
  '  500 Thu Aug 14 10:03:00 2026 /Applications/Cursor.app/Contents/MacOS/Cursor';
const PS_LINE_VIM =
  '  600 Thu Aug 14 10:04:00 2026 /usr/bin/vim file.txt';
const PS_LINE_AGY =
  '  700 Thu Aug 14 10:05:00 2026 /opt/homebrew/bin/agy';

function defaultPsStdout(): string {
  return [
    PS_LINE_CLAUDE,
    PS_LINE_CURSOR,
    PS_LINE_NODE_WRAPPER,
    PS_LINE_NODE_ONLY,
    PS_LINE_APPS,
    PS_LINE_VIM,
    PS_LINE_AGY,
  ].join('\n');
}

function defaultLsofStdout(): string {
  return [
    'p100',
    'n/Users/dev/project-a',
    'p200',
    'n/Users/dev/project-b',
    'p300',
    'n/Users/dev/project-c',
    'p700',
    'n/Users/dev/project-d',
  ].join('\n');
}

describe('createPsProcessScanner', () => {
  it('filters to allowlisted agent commands and excludes noise', async () => {
    const { runner } = createFakeRunner({
      handler(command, args) {
        if (command === 'ps') {
          return { stdout: defaultPsStdout(), stderr: '', exitCode: 0 };
        }
        if (command === 'lsof') {
          expect(args).toEqual(['-a', '-d', 'cwd', '-p', '100,200,300,700', '-Fpn']);
          return { stdout: defaultLsofStdout(), stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const scanner = createPsProcessScanner(runner);
    const processes = await scanner.listAgentProcesses();

    expect(processes).toEqual([
      {
        pid: 100,
        command: 'claude',
        cwd: '/Users/dev/project-a',
        startedAt: new Date('Thu Aug 14 09:12:33 2026'),
      },
      {
        pid: 200,
        command: 'cursor-agent',
        cwd: '/Users/dev/project-b',
        startedAt: new Date('Thu Aug 14 10:00:00 2026'),
      },
      {
        pid: 300,
        command: 'codex',
        cwd: '/Users/dev/project-c',
        startedAt: new Date('Thu Aug 14 10:01:00 2026'),
      },
      {
        pid: 700,
        command: 'agy',
        cwd: '/Users/dev/project-d',
        startedAt: new Date('Thu Aug 14 10:05:00 2026'),
      },
    ]);
  });

  it('excludes processes under /Applications/', async () => {
    const { runner } = createFakeRunner({
      handler(command) {
        if (command === 'ps') {
          return {
            stdout: `${PS_LINE_APPS}\n${PS_LINE_CLAUDE}`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'lsof') {
          return {
            stdout: 'p100\nn/Users/dev/project-a',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const scanner = createPsProcessScanner(runner);
    const processes = await scanner.listAgentProcesses();

    expect(processes.map((proc) => proc.pid)).toEqual([100]);
  });

  it('does not treat node-only processes as agents', async () => {
    const { runner } = createFakeRunner({
      handler(command) {
        if (command === 'ps') {
          return { stdout: PS_LINE_NODE_ONLY, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const scanner = createPsProcessScanner(runner);
    const processes = await scanner.listAgentProcesses();

    expect(processes).toEqual([]);
  });

  it('parses lsof p/n lines and drops processes without cwd', async () => {
    const { runner, calls } = createFakeRunner({
      handler(command) {
        if (command === 'ps') {
          return {
            stdout: `${PS_LINE_CLAUDE}\n  800 Thu Aug 14 10:06:00 2026 /usr/bin/gemini`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'lsof') {
          return {
            stdout: 'p100\nn/Users/dev/project-a',
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const scanner = createPsProcessScanner(runner);
    const processes = await scanner.listAgentProcesses();

    expect(calls.filter((call) => call.command === 'lsof')).toHaveLength(1);
    expect(processes).toEqual([
      {
        pid: 100,
        command: 'claude',
        cwd: '/Users/dev/project-a',
        startedAt: new Date('Thu Aug 14 09:12:33 2026'),
      },
    ]);
  });

  it('returns an empty array when ps or lsof fails', async () => {
    const psFail = createPsProcessScanner(
      createFakeRunner({
        handler() {
          return { stdout: '', stderr: 'fail', exitCode: 1 };
        },
      }).runner,
    );
    await expect(psFail.listAgentProcesses()).resolves.toEqual([]);

    const lsofFail = createPsProcessScanner(
      createFakeRunner({
        handler(command) {
          if (command === 'ps') {
            return { stdout: PS_LINE_CLAUDE, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: 'fail', exitCode: 1 };
        },
      }).runner,
    );
    await expect(lsofFail.listAgentProcesses()).resolves.toEqual([]);
  });

  it('keeps the processes lsof did report even when lsof exits non-zero', async () => {
    // lsof exits 1 when any requested pid has already gone away, but it still
    // prints cwd for the survivors.
    const { runner } = createFakeRunner({
      handler(command) {
        if (command === 'ps') {
          return {
            stdout: `${PS_LINE_CLAUDE}\n  800 Thu Aug 14 10:06:00 2026 /usr/bin/gemini`,
            stderr: '',
            exitCode: 0,
          };
        }
        return {
          stdout: 'p100\nn/Users/dev/project-a',
          stderr: 'lsof: no process ID found: 800',
          exitCode: 1,
        };
      },
    });

    const processes = await createPsProcessScanner(runner).listAgentProcesses();

    expect(processes).toEqual([
      {
        pid: 100,
        command: 'claude',
        cwd: '/Users/dev/project-a',
        startedAt: new Date('Thu Aug 14 09:12:33 2026'),
      },
    ]);
  });

  it('does not include argv in scanned results', async () => {
    const { runner } = createFakeRunner({
      handler(command) {
        if (command === 'ps') {
          return {
            stdout:
              '  900 Thu Aug 14 10:07:00 2026 /usr/bin/claude --api-key=SECRET --model opus',
            stderr: '',
            exitCode: 0,
          };
        }
        if (command === 'lsof') {
          return { stdout: 'p900\nn/Users/dev/secret-project', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 1 };
      },
    });

    const scanner = createPsProcessScanner(runner);
    const processes = await scanner.listAgentProcesses();

    expect(processes).toHaveLength(1);
    expect(processes[0]?.command).toBe('claude');
    expect(JSON.stringify(processes)).not.toContain('SECRET');
    expect(JSON.stringify(processes)).not.toContain('--api-key');
    expect(JSON.stringify(processes)).not.toContain('--model');
  });

  it('skips lsof when no agent processes are found', async () => {
    const { runner, calls } = createFakeRunner({
      handler(command) {
        if (command === 'ps') {
          return { stdout: PS_LINE_VIM, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const scanner = createPsProcessScanner(runner);
    await expect(scanner.listAgentProcesses()).resolves.toEqual([]);
    expect(calls.some((call) => call.command === 'lsof')).toBe(false);
  });
});
