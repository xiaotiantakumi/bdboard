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
  DEFAULT_SETTING_SOURCES,
  DENIED_TOOLS,
  resetClaudeVersionCacheForTests,
} from './claude-runner.js';
import { MINIMUM_CLAUDE_VERSION } from '../../domain/claude-version-check.js';

const tempWorktreeDirs: string[] = [];

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
  versionResult: StreamingCommandResult = {
    stdout: '2.1.233 (Claude Code)',
    stderr: '',
    exitCode: 0,
  },
): {
  streamingRunner: StreamingCommandRunner;
  runMock: Mock<
    (
      command: string,
      args: readonly string[],
      options: StreamingCommandRunOptions,
    ) => Promise<StreamingCommandResult>
  >;
  versionRunMock: Mock<
    (
      command: string,
      args: readonly string[],
      options?: StreamingCommandRunOptions,
    ) => Promise<StreamingCommandResult>
  >;
} {
  const runMock = vi.fn(async (command, args, _options) =>
    handler(command, args),
  );
  const versionRunMock = vi.fn(
    async (
      _command: string,
      _args: readonly string[],
      _options?: StreamingCommandRunOptions,
    ): Promise<StreamingCommandResult> => versionResult,
  );
  const run = async (
    command: string,
    args: readonly string[],
    options?: StreamingCommandRunOptions,
  ) => {
    if (args.length === 1 && args[0] === '--version') {
      return versionRunMock(command, args, options);
    }
    return runMock(command, args, options as StreamingCommandRunOptions);
  };
  return {
    streamingRunner: { run },
    runMock,
    versionRunMock,
  };
}

function expectedDefaultArgs(cwd = '/tmp/project'): readonly string[] {
  return [
    '-p',
    '--permission-mode',
    'default',
    '--setting-sources',
    DEFAULT_SETTING_SOURCES,
    '--allowedTools',
    ...DEFAULT_ALLOWED_TOOLS,
    `Read(/${cwd}/**)`,
    `Edit(/${cwd}/**)`,
    '--disallowedTools',
    ...DENIED_TOOLS,
    `Edit(/${cwd}/.claude/**)`,
    // `--` shields the prompt from the variadic `--allowedTools`.
    '--',
    'hello',
  ];
}

/**
 * argv を --allowedTools 節 / --disallowedTools 節に割る。
 * `.claude/**` ルールが deny 側ではなく allow 側に紛れ込むと、塞ぐつもりの穴を
 * 逆に開けることになる。`toContain` だけではその取り違えを検出できない。
 */
function splitPermissionSections(args: readonly string[]): {
  allowed: readonly string[];
  denied: readonly string[];
} {
  const allowAt = args.indexOf('--allowedTools');
  const denyAt = args.indexOf('--disallowedTools');
  expect(denyAt).toBeGreaterThanOrEqual(0);
  const end = args.indexOf('--', denyAt);
  return {
    allowed: allowAt < 0 ? [] : args.slice(allowAt + 1, denyAt),
    denied: args.slice(denyAt + 1, end < 0 ? args.length : end),
  };
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

describe('DEFAULT_SETTING_SOURCES', () => {
  // これが allowlist 主体を成立させている唯一の仕掛け (bdboard-jgx5)。値を変えると
  // 天井の性質が変わるので、明示的なテスト更新を強制する。
  it('pins the setting sources so the ceiling cannot be weakened silently', () => {
    expect(DEFAULT_SETTING_SOURCES).toBe('project,local');
  });

  it('excludes the user source, which is what makes the allowlist a real ceiling', () => {
    // user を読み込むと --allowedTools がユーザーのグローバル permissions.allow との
    // 和集合になり、上限として機能しなくなる (実測: グローバル allow にのみ載っている
    // `docker --version` が、このフラグ無しでは実行され、有りでは拒否された)。
    const sources = DEFAULT_SETTING_SOURCES.split(',');
    expect(sources).not.toContain('user');
  });

  it('keeps project and local so CLAUDE.md and the injected harness skills still load', () => {
    // '' (全ソース除外) にすると CLAUDE.md と worktree の .claude/skills/ まで
    // 落ちる (実測)。user 層だけを落とすのが目的。
    expect(DEFAULT_SETTING_SOURCES).not.toBe('');
    expect(DEFAULT_SETTING_SOURCES.split(',')).toEqual(['project', 'local']);
  });
});

describe('DENIED_TOOLS', () => {
  it('pins the exact deny list contents so weakening the ceiling requires an explicit test update', () => {
    expect(DENIED_TOOLS).toEqual([
      'WebFetch',
      'WebSearch',
      'Task',
      'Bash(sudo:*)',
      'Bash(npm:*)',
      'Bash(npx:*)',
      'Bash(pnpm:*)',
      'Bash(yarn:*)',
      'Bash(git push:*)',
      'Bash(bd dolt:*)',
      'Bash(mv:*)',
      'Bash(cp:*)',
      'Bash(rm:*)',
      'Bash(ln:*)',
      'Bash(chmod:*)',
      'Bash(chown:*)',
      'Bash(curl:*)',
      'Bash(wget:*)',
      'Bash(ssh:*)',
      'Bash(scp:*)',
      'Bash(docker:*)',
      'Bash(find:*)',
      'Bash(bash:*)',
      'Bash(sh:*)',
      'Bash(zsh:*)',
      'Bash(node:*)',
      'Bash(python:*)',
      'Bash(python3:*)',
      'Bash(eval:*)',
      'Bash(env:*)',
      'Bash(open:*)',
    ]);
  });

  it('does not deny bare Bash or conflict with DEFAULT_ALLOWED_TOOLS bash verbs', () => {
    expect(DENIED_TOOLS).not.toContain('Bash');

    const deniedBashVerbs = DENIED_TOOLS.filter((entry) => entry.startsWith('Bash('))
      .map((entry) => entry.slice('Bash('.length, -1).replace(/:\*$/, ''));

    for (const allowed of DEFAULT_ALLOWED_TOOLS) {
      if (!allowed.startsWith('Bash(')) {
        continue;
      }
      const verb = allowed.slice('Bash('.length, -1).replace(/:\*$/, '');
      expect(deniedBashVerbs).not.toContain(verb);
    }
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
    // 親の CLAUDE_CONFIG_DIR は素通しする (落とすと認証が壊れる)。
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
    // 正当な CLAUDE_*/ANTHROPIC_* 設定は引き続き通る。
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude');
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
    resetClaudeVersionCacheForTests();
    for (const dir of tempWorktreeDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('returns invalid-request when cwd contains characters that break the permission rule', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
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
      expect.objectContaining({
        cwd: '/tmp/project',
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
    });
    await runner.dispatch(makeRequest({ cwd: '/tmp/worktree-54be' }));

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    // 先頭スラッシュ2つ。1つだと claude CLI がプロジェクト相対と解釈して
    // 何にも一致せず、エージェントが一切編集できなくなる（実測）。
    expect(args).toContain('Read(//tmp/worktree-54be/**)');
    expect(args).toContain('Edit(//tmp/worktree-54be/**)');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    // B-1: --disallowedTools がグローバル permissions.allow に勝つ唯一の天井。
    expect(args).toContain('--disallowedTools');
    for (const tool of DENIED_TOOLS) {
      expect(args).toContain(tool);
    }
  });

  it('denies writes to the worktree .claude directory so the run cannot raise its own ceiling', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    await runner.dispatch(makeRequest({ cwd: '/tmp/worktree-f4kn' }));

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    const { allowed, denied } = splitPermissionSections(args);

    // bdboard-f4kn 実測: project 層 `.claude/settings.json` の hooks は permission
    // 層を通らずに実行され、しかも run の最中の差し替えがその場で効く。DENIED_TOOLS
    // をいくら足しても止まらないので、書き込み自体を deny する。
    expect(denied).toContain('Edit(//tmp/worktree-f4kn/.claude/**)');
    // 先頭スラッシュ2つ。1つだと CLI がプロジェクト相対と解釈して何にも一致せず、
    // deny が無言で効かなくなる (allow 側と同じ罠)。
    expect(denied).not.toContain('Edit(/tmp/worktree-f4kn/.claude/**)');
    // deny 節に入っていること。allow 節へ紛れ込めば逆に穴を開ける。
    expect(allowed).not.toContain('Edit(//tmp/worktree-f4kn/.claude/**)');
    // 広い方の allow は残っている (worktree 本体は編集できないと機能が死ぬ)。
    expect(allowed).toContain('Edit(//tmp/worktree-f4kn/**)');
  });

  it('keeps denying the worktree .claude directory when the allowlist is opted out', async () => {
    // BDBOARD_RUN_ALLOWED_TOOLS='' は allowlist ごと降ろす運用。天井が緩む分、
    // 自己昇格を塞ぐ必要はむしろ強い。allow が無いと deny も出ない実装だと
    // ここで落ちる。
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = '';

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    await runner.dispatch(makeRequest({ cwd: '/tmp/worktree-f4kn' }));

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    expect(args).not.toContain('--allowedTools');
    const { denied } = splitPermissionSections(args);
    expect(denied).toContain('Edit(//tmp/worktree-f4kn/.claude/**)');
  });

  it('removes worktree-local settings.local.json but keeps settings.json', async () => {
    const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-worktree-'));
    tempWorktreeDirs.push(tmpWorktree);

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
    });
    await runner.dispatch(makeRequest());

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('Read(//tmp/project/**)');
    expect(args).not.toContain('Edit(//tmp/project/**)');
  });

  it('still attaches --disallowedTools and DENIED_TOOLS when the allowlist is opted out', async () => {
    // deny 側は allowedTools の有無に関わらず必ず付ける (claude-runner.ts)。
    // allowlist を降ろした運用でも DENIED_TOOLS 天井は維持される。
    process.env.BDBOARD_RUN_ALLOWED_TOOLS = '';

    const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    await runner.dispatch(makeRequest());

    const args = runMock.mock.calls[0]?.[1] as readonly string[];
    expect(args).toContain('--disallowedTools');
    for (const tool of DENIED_TOOLS) {
      expect(args).toContain(tool);
    }
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
      const { streamingRunner, runMock } = createFakeStreamingRunner(() => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }));

      const runner = createClaudeRunner('claude-spawn', 'spawn', {
        streamingRunner,
      });
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

  it('rejects dispatch when claude CLI is too old', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(
      () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }),
      { stdout: '2.0.10 (Claude Code)', stderr: '', exitCode: 0 },
    );

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('runner-unavailable');
    expect(outcome.error).toContain('2.0.10');
    expect(outcome.error).toContain(MINIMUM_CLAUDE_VERSION);
    expect(outcome.error).toContain('--setting-sources');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('does not remove worktree-local settings when the version gate rejects dispatch', async () => {
    const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-worktree-'));
    tempWorktreeDirs.push(tmpWorktree);

    const claudeDir = path.join(tmpWorktree, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), '{"permissions":{}}');

    const { streamingRunner } = createFakeStreamingRunner(
      () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }),
      { stdout: '2.0.10 (Claude Code)', stderr: '', exitCode: 0 },
    );

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    await runner.dispatch(makeRequest({ cwd: tmpWorktree }));

    expect(fs.existsSync(path.join(claudeDir, 'settings.local.json'))).toBe(true);
  });

  it.each(['2.1.233 (Claude Code)', '3.0.0 (Claude Code)'])(
    'starts runs when claude CLI version %s meets the minimum',
    async (stdout) => {
      const { streamingRunner, runMock } = createFakeStreamingRunner(
        () => ({
          stdout: '',
          stderr: '',
          exitCode: 0,
        }),
        { stdout, stderr: '', exitCode: 0 },
      );

      const runner = createClaudeRunner('claude-spawn', 'spawn', {
        streamingRunner,
      });
      const outcome = await runner.dispatch(makeRequest());

      expect(outcome.ok).toBe(true);
      expect(runMock).toHaveBeenCalledTimes(1);
    },
  );

  it('continues dispatch when the version probe is inconclusive', async () => {
    const { streamingRunner, runMock } = createFakeStreamingRunner(
      () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }),
      { stdout: '', stderr: 'probe failed', exitCode: 1 },
    );

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(true);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('caches the claude --version probe for the process lifetime', async () => {
    const { streamingRunner, runMock, versionRunMock } = createFakeStreamingRunner(
      () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }),
    );

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });

    await runner.dispatch(makeRequest());
    await runner.dispatch(makeRequest());

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(versionRunMock).toHaveBeenCalledTimes(1);
  });

  it('leaves outcome.run.error undefined for non-zero exit with empty stderr and no translation', async () => {
    const { streamingRunner } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 2,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('failed');
    expect(outcome.error).toBe('claude exited with code 2');
    expect(outcome.run.error).toBeUndefined();
  });

  it('translates stderr when an old CLI rejects --setting-sources at runtime', async () => {
    const stderr = "error: unknown option '--setting-sources'";
    const { streamingRunner } = createFakeStreamingRunner(() => ({
      stdout: '',
      stderr,
      exitCode: 1,
    }));

    const runner = createClaudeRunner('claude-spawn', 'spawn', {
      streamingRunner,
    });
    const outcome = await runner.dispatch(makeRequest());

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('failed');
    expect(outcome.error).toContain(MINIMUM_CLAUDE_VERSION);
    expect(outcome.error).toContain('--setting-sources');
    expect(outcome.error).toContain(stderr);
    expect(outcome.run.error).toContain(MINIMUM_CLAUDE_VERSION);
  });
});
