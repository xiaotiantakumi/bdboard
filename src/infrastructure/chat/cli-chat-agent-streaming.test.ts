import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatAgentAbortedError,
  ChatAgentError,
} from '../../application/ports/chat-agent.js';
import type {
  StreamingCommandResult,
  StreamingCommandRunOptions,
  StreamingCommandRunner,
} from '../../application/ports/streaming-command-runner.js';
import { createCliChatAgent, type CliChatAgentSpec } from './cli-chat-agent.js';

function createDummySpec(
  overrides: Partial<CliChatAgentSpec> = {},
): CliChatAgentSpec {
  return {
    descriptor: {
      id: 'dummy-agent',
      label: 'Dummy Agent',
      model: 'default-model',
      models: [{ id: 'default-model', label: 'Default' }],
      experimental: false,
      capability: 'bd-only',
      supportsStreaming: true,
    },
    binaryPath: '/bin/dummy',
    envAllowlist: ['PATH'],
    versionArgs: ['--version'],
    timeoutMs: 1_000,
    supportsStreaming: true,
    buildTurn(request) {
      return { args: ['run'], stdin: request.message };
    },
    buildStreamingTurn(request) {
      return { args: ['stream'], stdin: request.message };
    },
    parseStreamChunk(line) {
      try {
        const parsed = JSON.parse(line) as { delta?: unknown };
        return typeof parsed.delta === 'string' ? { delta: parsed.delta } : undefined;
      } catch {
        return undefined;
      }
    },
    parseStreamResult(stdout) {
      return {
        reply: stdout,
        sessionId: 'stream-session',
        failedTools: [],
      };
    },
    parseTurn(result) {
      return { reply: result.stdout, sessionId: 'session', failedTools: [] };
    },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    projectRootPath: '/project',
    projectName: 'project',
    message: 'hello',
    ...overrides,
  };
}

function createStreamingRunner(
  handler: (options: StreamingCommandRunOptions) => Promise<StreamingCommandResult>,
): StreamingCommandRunner {
  return {
    async run(_command, _args, options) {
      return await handler(options);
    },
  };
}

describe('createCliChatAgent streaming', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes sendMessageStream and handles line-splitting chunks and result fallbacks', async () => {
    const deltas: string[] = [];
    const fullResult = '{"type":"result","reply":"done"}';
    const runner = createStreamingRunner(async (options) => {
      options.onChunk({ stream: 'stdout', text: '{"delta":"one"}\n{"delta":"two"}\n{"type":"stream_ev' });
      options.onChunk({ stream: 'stdout', text: 'ent","event":{}}\n' + fullResult });
      return { stdout: fullResult, stderr: '', exitCode: 0 };
    });
    const spec = createDummySpec({
      parseStreamResult: () => ({ reply: 'final', sessionId: 'final-session', failedTools: [] }),
    });
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      spec,
      {
        buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
        streamingCommandRunner: runner,
      },
    );

    expect(typeof agent.sendMessageStream).toBe('function');
    const result = await agent.sendMessageStream!(request({ model: 'requested-model' }), (delta) => {
      deltas.push(delta.text);
    });

    expect(deltas).toEqual(['one', 'two']);
    expect(result).toEqual({
      reply: 'final',
      sessionId: 'final-session',
      failedTools: [],
      agentId: 'dummy-agent',
      model: 'requested-model',
    });
  });

  it.each([
    ['supportsStreaming false', { supportsStreaming: false }],
    ['without buildStreamingTurn', { buildStreamingTurn: undefined }],
  ])('does not expose sendMessageStream when %s', (_label, override) => {
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      createDummySpec(override),
      { buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir: '/tmp' }) },
    );
    expect('sendMessageStream' in agent).toBe(false);
    expect(agent.sendMessageStream).toBeUndefined();
  });

  it('does not expose sendMessageStream without a streaming runner', () => {
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      createDummySpec(),
      { buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir: '/tmp' }) },
    );
    expect('sendMessageStream' in agent).toBe(false);
    expect(agent.sendMessageStream).toBeUndefined();
  });

  it.each([
    ['nonzero', { exitCode: 1 } as const, 'agent-exit-nonzero'],
    ['timeout', { exitCode: 1, failureKind: 'timeout' as const }, 'agent-timeout'],
  ])('maps a streaming runner %s failure to ChatAgentError', async (_label, result, code) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createStreamingRunner(async () => ({ stdout: '', stderr: 'failed', ...result }));
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      createDummySpec(),
      {
        buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
        streamingCommandRunner: runner,
      },
    );

    await expect(agent.sendMessageStream!(request(), () => {})).rejects.toMatchObject({
      code,
    });
    expect(await agent.sendMessageStream!(request(), () => {}).catch((error) => error)).toBeInstanceOf(ChatAgentError);
    errorSpy.mockRestore();
  });

  it('prefers spec.classifyFailure for streaming failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createStreamingRunner(async () => ({ stdout: '', stderr: '', exitCode: 1 }));
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      createDummySpec({ classifyFailure: () => 'agent-workspace-untrusted' }),
      {
        buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
        streamingCommandRunner: runner,
      },
    );
    await expect(agent.sendMessageStream!(request(), () => {})).rejects.toMatchObject({
      code: 'agent-workspace-untrusted',
    });
    errorSpy.mockRestore();
  });

  it('throws ChatAgentAbortedError for an aborted streaming runner', async () => {
    const runner = createStreamingRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 1,
      failureKind: 'aborted' as const,
    }));
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      createDummySpec(),
      {
        buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
        streamingCommandRunner: runner,
      },
    );
    const error = await agent.sendMessageStream!(request(), () => {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(ChatAgentAbortedError);
    expect(error).not.toBeInstanceOf(ChatAgentError);
  });

  it.each([
    ['success', { exitCode: 0 } as const],
    ['failure', { exitCode: 1 } as const],
    ['aborted', { exitCode: 1, failureKind: 'aborted' as const }],
  ])('cleans up lastMessageFile on %s', async (_label, result) => {
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-streaming-test-'));
    scratchDirs.push(scratchDir);
    const lastMessageFile = path.join(scratchDir, 'artifact.txt');
    const runner = createStreamingRunner(async () => ({ stdout: '', stderr: '', ...result }));
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      createDummySpec({
        buildStreamingTurn(request) {
          writeFileSync(lastMessageFile, 'artifact', 'utf8');
          return { args: ['stream'], stdin: request.message, lastMessageFile };
        },
      }),
      {
        buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir }),
        streamingCommandRunner: runner,
      },
    );

    const outcome = agent.sendMessageStream!(request(), () => {}).catch((error) => error);
    await outcome;
    expect(existsSync(lastMessageFile)).toBe(false);
  });

  it('passes the supplied AbortSignal through to the streaming runner', async () => {
    let receivedSignal: AbortSignal | undefined;
    const runner = createStreamingRunner(async (options) => {
      receivedSignal = options.signal;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const agent = createCliChatAgent(
      { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      createDummySpec(),
      {
        buildContext: () => ({ systemPrompt: '', mcpServers: [], toolNames: [], scratchDir: '/tmp' }),
        streamingCommandRunner: runner,
      },
    );
    const controller = new AbortController();
    await agent.sendMessageStream!(request(), () => {}, controller.signal);
    expect(receivedSignal).toBe(controller.signal);
  });
});
