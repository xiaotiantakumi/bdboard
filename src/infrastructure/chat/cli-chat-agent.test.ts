import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_FAILURE_MESSAGES,
  ChatAgentError,
} from '../../application/ports/chat-agent.js';
import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';
import { createCliChatAgent, type CliChatAgentSpec } from './cli-chat-agent.js';
import { MAX_FAILURE_LOG_CHARS } from './cli-failure.js';

function createFakeRunner(
  handler: (
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ) => Promise<CommandResult> | CommandResult,
): CommandRunner {
  return {
    async run(command, args, runOptions) {
      return await handler(command, args, runOptions);
    },
  };
}

function createDummySpec(
  overrides: Partial<CliChatAgentSpec> = {},
): CliChatAgentSpec {
  return {
    descriptor: {
      id: 'dummy-agent',
      label: 'Dummy Agent',
      models: [{ id: 'sonnet', label: 'Sonnet' }],
      experimental: false,
      capability: 'bd-only',
    },
    binaryPath: '/bin/dummy',
    envAllowlist: ['PATH', 'HOME'],
    versionArgs: ['--version'],
    timeoutMs: 1_000,
    buildTurn(request) {
      return {
        args: ['run'],
        stdin: request.message,
      };
    },
    parseTurn(result, _readArtifact) {
      return {
        reply: result.stdout,
        sessionId: 'sess-dummy',
        failedTools: [],
      };
    },
    ...overrides,
  };
}

describe('createCliChatAgent', () => {
  it('does not pass env keys outside the allowlist', async () => {
    const runner = createFakeRunner(async (_command, _args, options) => {
      expect(options?.env?.PATH).toBe('/bin');
      expect(options?.env?.HOME).toBe('/home/test');
      expect(options?.env?.SECRET_TOKEN).toBeUndefined();
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });

    const agent = createCliChatAgent(runner, createDummySpec(), {
      env: {
        PATH: '/bin',
        HOME: '/home/test',
        SECRET_TOKEN: 'leak',
      },
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'hello',
    });
  });

  it('truncates reply at 20,000 characters', async () => {
    const longReply = 'x'.repeat(25_000);
    const runner = createFakeRunner(async () => ({
      stdout: longReply,
      stderr: '',
      exitCode: 0,
    }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    const result = await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'hello',
    });

    expect(result.reply).toHaveLength(20_000);
    expect(result.agentId).toBe('dummy-agent');
  });

  it('truncates raw output in the server log, not in the client detail', async () => {
    const longDetail = 'e'.repeat(3_000);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({
      stdout: '',
      stderr: longDetail,
      exitCode: 1,
    }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await expect(
      agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      }),
    ).rejects.toMatchObject({
      code: 'agent-exit-nonzero',
      detail: CHAT_FAILURE_MESSAGES['agent-exit-nonzero'],
    });

    expect(errorSpy).toHaveBeenCalled();
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    const stderrPart = logged.slice(
      logged.indexOf('stderr=') + 'stderr='.length,
      logged.indexOf(' stdout='),
    );
    const stdoutPart = logged.slice(logged.indexOf('stdout=') + 'stdout='.length);
    expect(stderrPart.length).toBeLessThanOrEqual(MAX_FAILURE_LOG_CHARS);
    expect(stdoutPart.length).toBeLessThanOrEqual(MAX_FAILURE_LOG_CHARS);
    expect(stderrPart).toContain('…');
    expect(stderrPart).toContain('chars omitted…');
    expect(stdoutPart).toBe('');

    errorSpy.mockRestore();
  });

  it('checkAvailability falls back to versionArgs and returns unknown when the spec has no authProbe', async () => {
    const runner = createFakeRunner(async (_command, args, options) => {
      expect(args).toEqual(['--version']);
      expect(options?.timeoutMs).toBe(5_000);
      return { stdout: '1.0.0', stderr: '', exitCode: 0 };
    });

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await expect(agent.checkAvailability()).resolves.toBe('unknown');
  });

  it('checkAvailability returns unavailable when the fallback version command exits non-zero', async () => {
    const runner = createFakeRunner(async () => ({
      stdout: '',
      stderr: 'missing',
      exitCode: 1,
    }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await expect(agent.checkAvailability()).resolves.toBe('unavailable');
  });

  it('checkAvailability returns unavailable when the command fails to spawn', async () => {
    const interpret = vi.fn(() => 'available' as const);
    const runner = createFakeRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 127,
      failureKind: 'spawn-failed' as const,
    }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        authProbe: {
          args: ['auth', 'status', '--json'],
          interpret,
        },
      }),
      {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir: '/tmp',
        }),
      },
    );

    await expect(agent.checkAvailability()).resolves.toBe('unavailable');
    expect(interpret).not.toHaveBeenCalled();
  });

  it('checkAvailability runs the spec authProbe args instead of versionArgs', async () => {
    const interpret = vi.fn(() => 'available' as const);
    const runner = createFakeRunner(async (_command, args) => {
      expect(args).toEqual(['auth', 'status', '--json']);
      return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
    });

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        authProbe: {
          args: ['auth', 'status', '--json'],
          interpret,
        },
      }),
      {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir: '/tmp',
        }),
      },
    );

    await expect(agent.checkAvailability()).resolves.toBe('available');
    expect(interpret).toHaveBeenCalled();
  });

  it('checkAvailability never runs more than one child process per call', async () => {
    const run = vi.fn(async () => ({
      stdout: '1.0.0',
      stderr: '',
      exitCode: 0,
    }));
    const runner: CommandRunner = { run };

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await agent.checkAvailability();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('includes model from request.model in the turn result', async () => {
    const runner = createFakeRunner(async () => ({
      stdout: 'reply-text',
      stderr: '',
      exitCode: 0,
    }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        descriptor: {
          id: 'custom-id',
          label: 'Custom',
          model: 'sonnet',
          models: [
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'opus', label: 'Opus' },
          ],
          experimental: false,
          capability: 'bd-only',
        },
      }),
      {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir: '/tmp',
        }),
      },
    );

    const result = await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'hello',
      model: 'opus',
    });

    expect(result.model).toBe('opus');
  });

  it('includes descriptor.model in the turn result when request.model is omitted', async () => {
    const runner = createFakeRunner(async () => ({
      stdout: 'reply-text',
      stderr: '',
      exitCode: 0,
    }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        descriptor: {
          id: 'custom-id',
          label: 'Custom',
          model: 'sonnet',
          models: [
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'opus', label: 'Opus' },
          ],
          experimental: false,
          capability: 'bd-only',
        },
      }),
      {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir: '/tmp',
        }),
      },
    );

    const result = await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'hello',
    });

    expect(result.model).toBe('sonnet');
  });

  it('prefers the model measured by parseTurn over the requested model', async () => {
    const runner = createFakeRunner(async () => ({
      stdout: 'reply-text',
      stderr: '',
      exitCode: 0,
    }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        parseTurn(result, _readArtifact) {
          return {
            reply: result.stdout,
            sessionId: 'sess-dummy',
            failedTools: [],
            model: 'actual-model-from-cli',
          };
        },
      }),
      {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir: '/tmp',
        }),
      },
    );

    const result = await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'hello',
      model: 'requested-model',
    });

    expect(result.model).toBe('actual-model-from-cli');
  });

  it('returns agentId matching spec.descriptor.id', async () => {
    const runner = createFakeRunner(async () => ({
      stdout: 'reply-text',
      stderr: '',
      exitCode: 0,
    }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        descriptor: {
          id: 'custom-id',
          label: 'Custom',
          models: [{ id: 'sonnet', label: 'Sonnet' }],
          experimental: false,
          capability: 'bd-only',
        },
      }),
      {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir: '/tmp',
        }),
      },
    );

    const result = await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'hello',
    });

    expect(result.agentId).toBe('custom-id');
  });

  it('classifies a non-zero exit as agent-exit-nonzero', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 3,
    }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await expect(
      agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      }),
    ).rejects.toMatchObject({
      code: 'agent-exit-nonzero',
      detail: CHAT_FAILURE_MESSAGES['agent-exit-nonzero'],
    });

    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('agent=dummy-agent');
    expect(logged).toContain('exitCode=3');

    errorSpy.mockRestore();
  });

  it('parseTurn errors propagate as ChatAgentError', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawStdout = 'not-json';
    const runner = createFakeRunner(async () => ({
      stdout: rawStdout,
      stderr: '',
      exitCode: 0,
    }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        parseTurn(_result, _readArtifact) {
          throw new ChatAgentError('agent-bad-output');
        },
      }),
      {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir: '/tmp',
        }),
      },
    );

    await expect(
      agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      }),
    ).rejects.toMatchObject({
      code: 'agent-bad-output',
      detail: CHAT_FAILURE_MESSAGES['agent-bad-output'],
    });

    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain(rawStdout);

    errorSpy.mockRestore();
  });

  it('does not put child process stderr into the error surfaced to clients', async () => {
    const secret = 'sk-test-not-a-real-key';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({
      stdout: `ANTHROPIC_API_KEY=${secret}`,
      stderr: `auth failed: ${secret} at /Users/someone/secret/path`,
      exitCode: 1,
    }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    let caught: ChatAgentError | undefined;
    try {
      await agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      });
    } catch (err) {
      caught = err as ChatAgentError;
    }

    expect(caught).toBeInstanceOf(ChatAgentError);
    expect(caught!.detail).not.toContain(secret);
    expect(caught!.message).not.toContain(secret);
    expect(
      JSON.stringify({
        error: 'chat failed',
        code: caught!.code,
        detail: caught!.detail,
      }),
    ).not.toContain(secret);

    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain(secret);

    errorSpy.mockRestore();
  });

  it('maps spawn-failed to agent-not-found', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({
      stdout: '',
      stderr: 'ENOENT',
      exitCode: -1,
      failureKind: 'spawn-failed',
    }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await expect(
      agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      }),
    ).rejects.toMatchObject({
      code: 'agent-not-found',
      detail: CHAT_FAILURE_MESSAGES['agent-not-found'],
    });

    errorSpy.mockRestore();
  });

  it('maps timeout to agent-timeout', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({
      stdout: '',
      stderr: 'timed out',
      exitCode: -1,
      failureKind: 'timeout',
    }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({
        systemPrompt: 'sys',
        mcpServers: [],
        toolNames: [],
        scratchDir: '/tmp',
      }),
    });

    await expect(
      agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      }),
    ).rejects.toMatchObject({
      code: 'agent-timeout',
      detail: CHAT_FAILURE_MESSAGES['agent-timeout'],
    });

    errorSpy.mockRestore();
  });

  // bdboard-l1t.5 Opus レビュー SF6(a): resume ターンで CLI が要求と違う session_id
  // を返してきたら、致命的エラーにはせず(会話は継続させる)サーバーログにだけ
  // console.warn で警告する。
  it('warns (but does not throw) when a resumed turn returns a different session_id than requested (SF6a)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({ stdout: 'reply', stderr: '', exitCode: 0 }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        parseTurn(result) {
          return { reply: result.stdout, sessionId: 'actually-returned-session', failedTools: [] };
        },
      }),
      {
        buildContext: () => ({ systemPrompt: 'sys', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
      },
    );

    const result = await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'continue',
      resumeSessionId: 'requested-session',
    });

    expect(result.sessionId).toBe('actually-returned-session');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnedText = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnedText).toContain('requested-session');
    expect(warnedText).toContain('actually-returned-session');
    // dummy-agent は createDummySpec の既定 descriptor.id。
    expect(warnedText).toContain('dummy-agent');

    warnSpy.mockRestore();
  });

  it('does not warn when the returned session_id matches the requested resumeSessionId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({ stdout: 'reply', stderr: '', exitCode: 0 }));

    const agent = createCliChatAgent(
      runner,
      createDummySpec({
        parseTurn(result) {
          return { reply: result.stdout, sessionId: 'same-session', failedTools: [] };
        },
      }),
      {
        buildContext: () => ({ systemPrompt: 'sys', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
      },
    );

    await agent.sendMessage({
      projectRootPath: '/proj',
      projectName: 'proj',
      message: 'continue',
      resumeSessionId: 'same-session',
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn on a brand-new (non-resume) turn even though there is no resumeSessionId to compare against', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = createFakeRunner(async () => ({ stdout: 'reply', stderr: '', exitCode: 0 }));

    const agent = createCliChatAgent(runner, createDummySpec(), {
      buildContext: () => ({ systemPrompt: 'sys', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
    });

    await agent.sendMessage({ projectRootPath: '/proj', projectName: 'proj', message: 'hello' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  describe('lastMessageFile cleanup (bdboard-l1t.4 SF8)', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    function makeTempDir(): string {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cli-chat-agent-test-'));
      tempDirs.push(dir);
      return dir;
    }

    it('deletes the lastMessageFile inside scratchDir after a successful turn', async () => {
      const scratchDir = makeTempDir();
      const lastMessageFile = path.join(scratchDir, 'artifact.txt');
      writeFileSync(lastMessageFile, 'reply-from-artifact', 'utf8');

      const runner = createFakeRunner(async () => ({
        stdout: 'ignored',
        stderr: '',
        exitCode: 0,
      }));

      const agent = createCliChatAgent(
        runner,
        createDummySpec({
          buildTurn(request) {
            return { args: ['run'], stdin: request.message, lastMessageFile };
          },
          parseTurn(_result, readLastMessageFile) {
            return {
              reply: readLastMessageFile() ?? '',
              sessionId: 'sess-dummy',
              failedTools: [],
            };
          },
        }),
        {
          buildContext: () => ({
            systemPrompt: 'sys',
            mcpServers: [],
            toolNames: [],
            scratchDir,
          }),
        },
      );

      const result = await agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      });

      expect(result.reply).toBe('reply-from-artifact');
      expect(existsSync(lastMessageFile)).toBe(false);
    });

    it('deletes the lastMessageFile inside scratchDir even when the CLI exits non-zero', async () => {
      const scratchDir = makeTempDir();
      const lastMessageFile = path.join(scratchDir, 'artifact.txt');
      writeFileSync(lastMessageFile, 'partial', 'utf8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const runner = createFakeRunner(async () => ({
        stdout: '',
        stderr: 'boom',
        exitCode: 1,
      }));

      const agent = createCliChatAgent(
        runner,
        createDummySpec({
          buildTurn(request) {
            return { args: ['run'], stdin: request.message, lastMessageFile };
          },
        }),
        {
          buildContext: () => ({
            systemPrompt: 'sys',
            mcpServers: [],
            toolNames: [],
            scratchDir,
          }),
        },
      );

      await expect(
        agent.sendMessage({
          projectRootPath: '/proj',
          projectName: 'proj',
          message: 'hello',
        }),
      ).rejects.toBeInstanceOf(ChatAgentError);

      expect(existsSync(lastMessageFile)).toBe(false);
      errorSpy.mockRestore();
    });

    it('deletes the lastMessageFile inside scratchDir even when parseTurn throws', async () => {
      const scratchDir = makeTempDir();
      const lastMessageFile = path.join(scratchDir, 'artifact.txt');
      writeFileSync(lastMessageFile, 'partial', 'utf8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const runner = createFakeRunner(async () => ({
        stdout: 'not-json',
        stderr: '',
        exitCode: 0,
      }));

      const agent = createCliChatAgent(
        runner,
        createDummySpec({
          buildTurn(request) {
            return { args: ['run'], stdin: request.message, lastMessageFile };
          },
          parseTurn() {
            throw new ChatAgentError('agent-bad-output');
          },
        }),
        {
          buildContext: () => ({
            systemPrompt: 'sys',
            mcpServers: [],
            toolNames: [],
            scratchDir,
          }),
        },
      );

      await expect(
        agent.sendMessage({
          projectRootPath: '/proj',
          projectName: 'proj',
          message: 'hello',
        }),
      ).rejects.toMatchObject({ code: 'agent-bad-output' });

      expect(existsSync(lastMessageFile)).toBe(false);
      errorSpy.mockRestore();
    });

    it('refuses to delete and logs an error when lastMessageFile resolves outside scratchDir', async () => {
      const scratchDir = makeTempDir();
      const outsideDir = makeTempDir();
      const outsideFile = path.join(outsideDir, 'not-mine.txt');
      writeFileSync(outsideFile, 'do not delete me', 'utf8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const runner = createFakeRunner(async () => ({
        stdout: 'reply-text',
        stderr: '',
        exitCode: 0,
      }));

      const agent = createCliChatAgent(
        runner,
        createDummySpec({
          buildTurn(request) {
            // spec のバグを模す: scratchDir 配下ではないパスを返す。
            return { args: ['run'], stdin: request.message, lastMessageFile: outsideFile };
          },
        }),
        {
          buildContext: () => ({
            systemPrompt: 'sys',
            mcpServers: [],
            toolNames: [],
            scratchDir,
          }),
        },
      );

      await agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      });

      expect(existsSync(outsideFile)).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
      const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(logged).toContain(outsideFile);
      expect(logged).toContain(scratchDir);

      errorSpy.mockRestore();
    });

    it('recursively deletes temporaryDirs inside scratchDir after a turn', async () => {
      const scratchDir = makeTempDir();
      const turnDir = mkdtempSync(path.join(scratchDir, 'bdboard-turn-artifact-'));
      const nestedFile = path.join(turnDir, 'last-message.txt');
      writeFileSync(nestedFile, 'reply-from-artifact', 'utf8');

      const runner = createFakeRunner(async () => ({
        stdout: 'ignored',
        stderr: '',
        exitCode: 0,
      }));

      const agent = createCliChatAgent(
        runner,
        createDummySpec({
          buildTurn(request) {
            return {
              args: ['run'],
              stdin: request.message,
              lastMessageFile: nestedFile,
              temporaryDirs: [turnDir],
            };
          },
          parseTurn(_result, readLastMessageFile) {
            return {
              reply: readLastMessageFile() ?? '',
              sessionId: 'sess-dummy',
              failedTools: [],
            };
          },
        }),
        {
          buildContext: () => ({
            systemPrompt: 'sys',
            mcpServers: [],
            toolNames: [],
            scratchDir,
          }),
        },
      );

      const result = await agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      });

      expect(result.reply).toBe('reply-from-artifact');
      expect(existsSync(turnDir)).toBe(false);
      expect(existsSync(nestedFile)).toBe(false);
    });

    it('refuses to delete and logs an error when temporaryDirs resolves outside scratchDir', async () => {
      const scratchDir = makeTempDir();
      const outsideDir = makeTempDir();
      const outsideFile = path.join(outsideDir, 'not-mine.txt');
      writeFileSync(outsideFile, 'do not delete me', 'utf8');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const runner = createFakeRunner(async () => ({
        stdout: 'reply-text',
        stderr: '',
        exitCode: 0,
      }));

      const agent = createCliChatAgent(
        runner,
        createDummySpec({
          buildTurn(request) {
            // spec のバグを模す: scratchDir 配下ではないディレクトリを返す。
            return {
              args: ['run'],
              stdin: request.message,
              lastMessageFile: outsideFile,
              temporaryDirs: [outsideDir],
            };
          },
        }),
        {
          buildContext: () => ({
            systemPrompt: 'sys',
            mcpServers: [],
            toolNames: [],
            scratchDir,
          }),
        },
      );

      await agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      });

      expect(existsSync(outsideDir)).toBe(true);
      expect(existsSync(outsideFile)).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
      const dirRefusal = errorSpy.mock.calls.find((call) => {
        const logged = String(call[0] ?? '');
        return logged.includes('refusing to delete temporary directory outside scratchDir')
          && logged.includes(`dir=${outsideDir}`);
      });
      expect(dirRefusal).toBeDefined();
      const logged = String(dirRefusal![0] ?? '');
      expect(logged).toContain(scratchDir);

      errorSpy.mockRestore();
    });

    it('does not attempt deletion when the spec omits lastMessageFile', async () => {
      const scratchDir = makeTempDir();
      const runner = createFakeRunner(async () => ({
        stdout: 'reply-text',
        stderr: '',
        exitCode: 0,
      }));

      const agent = createCliChatAgent(runner, createDummySpec(), {
        buildContext: () => ({
          systemPrompt: 'sys',
          mcpServers: [],
          toolNames: [],
          scratchDir,
        }),
      });

      const result = await agent.sendMessage({
        projectRootPath: '/proj',
        projectName: 'proj',
        message: 'hello',
      });

      expect(result.reply).toBe('reply-text');
    });
  });
});
