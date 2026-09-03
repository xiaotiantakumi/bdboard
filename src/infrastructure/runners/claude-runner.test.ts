import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { RunRequest } from '../../application/ports/agent-runner.js';
import type {
  StreamingCommandResult,
  StreamingCommandRunOptions,
  StreamingCommandRunner,
} from '../../application/ports/streaming-command-runner.js';
import {
  ALLOWED_BASH_WILDCARD_VERBS,
  buildRunnerEnv,
  createClaudeRunner,
  DEFAULT_ALLOWED_TOOLS,
} from './claude-runner.js';

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    prompt: 'hello',
    ...overrides,
  };
}

function createFakeStreamingRunner(
  handler: (
    command: string,
    args: readonly string[],
  ) => Promise<StreamingCommandResult> | StreamingCommandResult,
): {
  streamingRunner: StreamingCommandRunner;
  runMock: Mock<
    (
      command: string,
      args: readonly string[],
      options: StreamingCommandRunOptions,
    ) => Promise<StreamingCommandResult>
  >;
} {
  const runMock = vi.fn(async (command, args) => handler(command, args));
  return {
    streamingRunner: { run: runMock },
    runMock,
  };
}

function expectedDefaultArgs(cwd = '/tmp/project'): readonly string[] {
  return [
    '-p',
    '--permission-mode',
    'default',
    '--allowedTools',
    ...DEFAULT_ALLOWED_TOOLS,
    `Edit(/${cwd}/**)`,
    // `--` shields the prompt from the variadic `--allowedTools`.
    '--',
    'hello',
  ];
}

describe('DEFAULT_ALLOWED_TOOLS', () => {
  it('allows Bash(:*) wildcards only for the approved verb list', () => {
    const bashEntries = DEFAULT_ALLOWED_TOOLS.filter((entry) =>
      entry.startsWith('Bash('),
    );

    for (const entry of bashEntries) {
      const inner = entry.slice('Bash('.length, -1);
      if (inner.endsWith(':*')) {
        const verb = inner.slice(0, -2);
        expect(ALLOWED_BASH_WILDCARD_VERBS).toContain(verb);
      }
    }

    for (const verb of ALLOWED_BASH_WILDCARD_VERBS) {
      expect(DEFAULT_ALLOWED_TOOLS).toContain(`Bash(${verb}:*)`);
    }
  });

  it('does not include bare Bash(git:*) / Bash(npm:*) / Bash(bd:*) wildcards', () => {
    const bareWildcards = DEFAULT_ALLOWED_TOOLS.filter((entry) => {
      const match = /^Bash\(([^:]+):\*\)$/.exec(entry);
      return match !== null && !match[1].includes(' ');
    });

    expect(bareWildcards).toEqual([]);
  });

  it('does not include bare Write or Edit without path scope', () => {
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Write');
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Edit');
  });
});

describe('buildRunnerEnv', () => {
  it('drops the nested-session control credentials even though they match the CLAUDE_ prefix', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
    });

    // プレフィックス一致でも、親セッションへの制御チャネルの資格情報は渡さない。
    expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_TOKEN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_SOCKET');
    // 正当な CLAUDE_*/ANTHROPIC_* 設定は引き続き通る。
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
  });

  it('passes allowlisted vars and drops secrets', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'example-key',
      CLAUDE_CODE_ENTRYPOINT: 'claude',
      BDBOARD_SECRET_TOKEN: 'must-not-leak',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'example-key',
      CLAUDE_CODE_ENTRYPOINT: 'claude',
    });
    expect(env).not.toHaveProperty('BDBOARD_SECRET_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });
});

describe('createClaudeRunner', () => {
  afterEach(() => {
    delete process.env.BDBOARD_RUN_PERMISSION_MODE;
    delete process.env.BDBOARD_RUN_ALLOWED_TOOLS;
    delete process.env.BDBOARD_TEST_SECRET_ENV;
    vi.restoreAllMocks();
  });

  it('returns dispatch-disabled when streamingRunner is not wired', async () => {
    const runner = createClaudeRunner('claude-spawn', 'spawn');
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('dispatch-disabled');
    expect(outcome.error).toContain(
      `would run: claude ${expectedDefaultArgs().join(' ')}`,
    );
  });

  it('succeeds when streamingRunner exits zero', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: 'done',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });

    const chunks: string[] = [];
    const outcome = await runner.dispatch(makeRequest(), {
      onChunk: (chunk) => {
        chunks.push(`${chunk.stream}:${chunk.text}`);
      },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.run.status).toBe('succeeded');
    expect(outcome.run.exitCode).toBe(0);
    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expectedDefaultArgs(),
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('includes worktree-scoped Edit in args and defaults permission-mode to default', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    await runner.dispatch(makeRequest({ cwd: '/tmp/worktree-54be' }));

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    // 先頭スラッシュ2つ。1つだと claude CLI がプロジェクト相対と解釈して
    // 何にも一致せず、エージェントが一切編集できなくなる（実測）。
    expect(args).toContain('Edit(//tmp/worktree-54be/**)');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
  });

  it('reports failed outcome for non-zero exit', async () => {
    const { streamingRunner } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: 'boom',
      exitCode: 2,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('failed');
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.exitCode).toBe(2);
  });

  it('maps spawn failure to runner-unavailable', async () => {
    const { streamingRunner } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: 'ENOENT',
      exitCode: 127,
      failureKind: 'spawn-failed',
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('runner-unavailable');
    expect(outcome.run.status).toBe('failed');
  });

  it('maps aborted runs to cancelled status', async () => {
    const { streamingRunner } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: 'aborted by user',
      exitCode: 143,
      failureKind: 'aborted',
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('failed');
    expect(outcome.run.status).toBe('cancelled');
  });

  it('warns and falls back when BDBOARD_RUN_PERMISSION_MODE is unknown', async () => {
    process.env.BDBOARD_RUN_PERMISSION_MODE = 'totally-invalid';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    await runner.dispatch(makeRequest());

    expect(warnSpy).toHaveBeenCalledWith(
      'unknown BDBOARD_RUN_PERMISSION_MODE "totally-invalid", falling back to default',
    );
    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--permission-mode', 'default']),
      expect.any(Object),
    );
  });

  it('omits allowedTools when BDBOARD_RUN_ALLOWED_TOOLS is empty', async () => {
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = '';

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    await runner.dispatch(makeRequest());

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('Edit(//tmp/project/**)');
  });

  it('parses BDBOARD_RUN_ALLOWED_TOOLS as a JSON array', async () => {
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = JSON.stringify([
      'Read',
      'Bash(git diff:*)',
    ]);

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    await runner.dispatch(makeRequest());

    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--allowedTools', 'Read', 'Bash(git diff:*)']),
      expect.any(Object),
    );
  });

  it('warns and falls back when BDBOARD_RUN_ALLOWED_TOOLS is invalid JSON', async () => {
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = 'Read,Write';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    await runner.dispatch(makeRequest());

    expect(warnSpy).toHaveBeenCalledWith(
      'BDBOARD_RUN_ALLOWED_TOOLS is not valid JSON; falling back to defaults',
    );
    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--allowedTools', ...DEFAULT_ALLOWED_TOOLS]),
      expect.any(Object),
    );
  });

  it('warns and falls back when BDBOARD_RUN_ALLOWED_TOOLS is not a string array', async () => {
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = JSON.stringify({ tools: ['Read'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
    await runner.dispatch(makeRequest());

    expect(warnSpy).toHaveBeenCalledWith(
      'BDBOARD_RUN_ALLOWED_TOOLS must be a JSON array of non-empty strings; falling back to defaults',
    );
    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--allowedTools', ...DEFAULT_ALLOWED_TOOLS]),
      expect.any(Object),
    );
  });

  it('uses explicit allowedTools over env and defaults', async () => {
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = JSON.stringify(['Shell']);

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      allowedTools: ['Read'],
    });
    await runner.dispatch(makeRequest());

    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--allowedTools', 'Read', 'Edit(//tmp/project/**)']),
      expect.any(Object),
    );
    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    expect(args).not.toContain('Shell');
  });


  it('does not pass non-allowlisted env vars to the child process', async () => {
    const previousSecretEnv = process.env.BDBOARD_TEST_SECRET_ENV;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.BDBOARD_TEST_SECRET_ENV = 'example-secret-value';
    process.env.ANTHROPIC_API_KEY = 'example-anthropic-key';

    try {
      const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const runner = createClaudeRunner('claude-spawn', 'spawn', { streamingRunner });
      await runner.dispatch(makeRequest());

      const options = runMock.mock.calls[0]?.[2] as StreamingCommandRunOptions;
      expect(options.env).toBeDefined();
      expect(options.env).not.toHaveProperty('BDBOARD_TEST_SECRET_ENV');
      if (process.env.PATH !== undefined) {
        expect(options.env?.PATH).toBe(process.env.PATH);
      }
      expect(options.env?.ANTHROPIC_API_KEY).toBe('example-anthropic-key');
    } finally {
      if (previousSecretEnv === undefined) {
        delete process.env.BDBOARD_TEST_SECRET_ENV;
      } else {
        process.env.BDBOARD_TEST_SECRET_ENV = previousSecretEnv;
      }
      if (previousAnthropicKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      }
    }
  });
});
