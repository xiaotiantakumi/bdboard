import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  DENIED_TOOLS,
  ensureManagedClaudeConfig,
} from './claude-runner.js';

const tempConfigDirs: string[] = [];

function makeTempClaudeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-claude-config-'));
  tempConfigDirs.push(dir);
  return dir;
}

function runnerOptions(
  overrides: {
    readonly claudeConfigDir?: string;
    readonly streamingRunner?: StreamingCommandRunner;
    readonly allowedTools?: readonly string[];
  } = {},
) {
  return {
    claudeConfigDir: overrides.claudeConfigDir ?? makeTempClaudeConfigDir(),
    ...overrides,
  };
}

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
    `Read(/${cwd}/**)`,
    `Edit(/${cwd}/**)`,
    '--disallowedTools',
    ...DENIED_TOOLS,
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

  it('does not include bare Read without path scope', () => {
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Read');
  });

  it('pins the exact allowlist contents so widening it requires an explicit test update', () => {
    expect(DEFAULT_ALLOWED_TOOLS).toEqual([
      'Glob',
      'Grep',
      'Bash(bd show:*)',
      'Bash(bd list:*)',
      'Bash(bd comment:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git add:*)',
      'Bash(git commit:*)',
    ]);
  });
});

describe('buildRunnerEnv', () => {
  it('drops the nested-session control credentials even though they match the CLAUDE_ prefix', () => {
    const env = buildRunnerEnv({
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
      CLAUDE_CODE_ENTRYPOINT: 'claude',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
    });

    // プレフィックス一致でも、親セッションへの制御チャネルの資格情報は渡さない。
    expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_TOKEN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_MESSAGING_SOCKET');
    // 親の CLAUDE_CONFIG_DIR も素通ししない (B-1)。
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    // 正当な CLAUDE_*/ANTHROPIC_* 設定は引き続き通る。
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude');
  });

  it('sets CLAUDE_CONFIG_DIR when claudeConfigDir option is provided', () => {
    const env = buildRunnerEnv(
      { PATH: '/usr/bin' },
      { claudeConfigDir: '/managed/claude-config' },
    );

    expect(env.CLAUDE_CONFIG_DIR).toBe('/managed/claude-config');
  });

  it('prefers claudeConfigDir option over parent CLAUDE_CONFIG_DIR', () => {
    const env = buildRunnerEnv(
      {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/home/u/.claude',
      },
      { claudeConfigDir: '/managed/claude-config' },
    );

    expect(env.CLAUDE_CONFIG_DIR).toBe('/managed/claude-config');
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

describe('ensureManagedClaudeConfig', () => {
  afterEach(() => {
    for (const dir of tempConfigDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes settings.json with empty allow and full deny list', () => {
    const dir = makeTempClaudeConfigDir();
    const result = ensureManagedClaudeConfig(dir);

    expect(result).toEqual({ ok: true });

    const settings = JSON.parse(
      fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'),
    ) as {
      permissions: { allow: string[]; deny: string[] };
    };

    expect(settings.permissions.allow).toEqual([]);
    for (const tool of DENIED_TOOLS) {
      expect(settings.permissions.deny).toContain(tool);
    }
  });

  it('overwrites tampered settings.json on each call', () => {
    const dir = makeTempClaudeConfigDir();
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(mv:*)'], deny: [] } }),
    );

    const result = ensureManagedClaudeConfig(dir);

    expect(result).toEqual({ ok: true });
    const settings = JSON.parse(
      fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'),
    ) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.allow).toEqual([]);
    for (const tool of DENIED_TOOLS) {
      expect(settings.permissions.deny).toContain(tool);
    }
  });

  it('rejects settings.local.json in the managed directory', () => {
    const dir = makeTempClaudeConfigDir();
    fs.writeFileSync(path.join(dir, 'settings.local.json'), '{}');

    const result = ensureManagedClaudeConfig(dir);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('settings.local.json');
  });

  it('rejects .claude.json in the managed directory', () => {
    const dir = makeTempClaudeConfigDir();
    fs.writeFileSync(path.join(dir, '.claude.json'), '{}');

    const result = ensureManagedClaudeConfig(dir);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('.claude.json');
  });
});

describe('createClaudeRunner', () => {
  afterEach(() => {
    delete process.env.BDBOARD_RUN_PERMISSION_MODE;
    delete process.env.BDBOARD_RUN_ALLOWED_TOOLS;
    delete process.env.BDBOARD_TEST_SECRET_ENV;
    for (const dir of tempConfigDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('returns dispatch-disabled when streamingRunner is not wired', async () => {
    const claudeConfigDir = makeTempClaudeConfigDir();
    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      claudeConfigDir,
    });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('dispatch-disabled');
    expect(outcome.error).toContain(
      `would run: claude ${expectedDefaultArgs().join(' ')}`,
    );
  });

  it('returns invalid-request when managed claude config is unusable', async () => {
    const claudeConfigDir = makeTempClaudeConfigDir();
    fs.writeFileSync(path.join(claudeConfigDir, 'settings.local.json'), '{}');

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      claudeConfigDir,
    });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('invalid-request');
    expect(outcome.error).toContain('managed claude config is not usable');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('returns invalid-request when cwd contains characters that break the permission rule', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });

    for (const cwd of ['/tmp/worktree-bad)', '/tmp/worktree-bad*']) {
      const outcome = await runner.dispatch(makeRequest({ cwd }));

      expect(outcome.ok).toBe(false);
      expect(outcome.failureKind).toBe('invalid-request');
      expect(outcome.error).toContain('break the permission rule');
    }

    expect(runMock).not.toHaveBeenCalled();
  });

  it('succeeds when streamingRunner exits zero', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: 'done',
      stderr: '',
      exitCode: 0,
    }));

    const claudeConfigDir = makeTempClaudeConfigDir();
    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      claudeConfigDir,
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
      expect.objectContaining({
        cwd: '/tmp/project',
        env: expect.objectContaining({
          CLAUDE_CONFIG_DIR: claudeConfigDir,
        }),
      }),
    );
  });

  it('includes worktree-scoped Read and Edit in args and defaults permission-mode to default', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
    await runner.dispatch(makeRequest({ cwd: '/tmp/worktree-54be' }));

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    // 先頭スラッシュ2つ。1つだと claude CLI がプロジェクト相対と解釈して
    // 何にも一致せず、エージェントが一切編集できなくなる（実測）。
    expect(args).toContain('Read(//tmp/worktree-54be/**)');
    expect(args).toContain('Edit(//tmp/worktree-54be/**)');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args).toContain('--disallowedTools');
    for (const tool of DENIED_TOOLS) {
      expect(args).toContain(tool);
    }
  });

  it('removes worktree-local settings.local.json but keeps settings.json', async () => {
    const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-worktree-'));
    tempConfigDirs.push(tmpWorktree);

    const claudeDir = path.join(tmpWorktree, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), '{"permissions":{}}');
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"permissions":{}}');

    const { streamingRunner } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
    await runner.dispatch(makeRequest({ cwd: tmpWorktree }));

    expect(fs.existsSync(path.join(claudeDir, 'settings.local.json'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
  });

  it('reports failed outcome for non-zero exit', async () => {
    const { streamingRunner } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: 'boom',
      exitCode: 2,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
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

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
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

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
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

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
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

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
    await runner.dispatch(makeRequest());

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('Read(//tmp/project/**)');
    expect(args).not.toContain('Edit(//tmp/project/**)');
  });

  it('parses BDBOARD_RUN_ALLOWED_TOOLS as a JSON array', async () => {
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = JSON.stringify([
      'Glob',
      'Bash(git diff:*)',
    ]);

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
    await runner.dispatch(makeRequest());

    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '--allowedTools',
        'Glob',
        'Bash(git diff:*)',
        'Read(//tmp/project/**)',
        'Edit(//tmp/project/**)',
      ]),
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

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
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
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = JSON.stringify({ tools: ['Glob'] });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
      ...runnerOptions(),
    });
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
      allowedTools: ['Glob'],
      ...runnerOptions(),
    });
    await runner.dispatch(makeRequest());

    expect(runMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '--allowedTools',
        'Glob',
        'Read(//tmp/project/**)',
        'Edit(//tmp/project/**)',
      ]),
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
      const claudeConfigDir = makeTempClaudeConfigDir();
      const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const runner = createClaudeRunner('claude-spawn', 'spawn', {
        streamingRunner,
        claudeConfigDir,
      });
      await runner.dispatch(makeRequest());

      const options = runMock.mock.calls[0]?.[2] as StreamingCommandRunOptions;
      expect(options.env).toBeDefined();
      expect(options.env).not.toHaveProperty('BDBOARD_TEST_SECRET_ENV');
      if (process.env.PATH !== undefined) {
        expect(options.env?.PATH).toBe(process.env.PATH);
      }
      expect(options.env?.ANTHROPIC_API_KEY).toBe('example-anthropic-key');
      expect(options.env?.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
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
