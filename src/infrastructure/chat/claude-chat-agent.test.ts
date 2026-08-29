import { describe, expect, it } from 'vitest';
import { CHAT_FAILURE_MESSAGES } from '../../application/ports/chat-agent.js';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { CHAT_TOOL_DEFINITIONS } from './chat-tool-catalog.js';
import { createClaudeChatAgent } from './claude-chat-agent.js';

const PROJECT_ROOT = '/tmp/bdboard-chat-agent';
const PROJECT_NAME = 'bdboard-test';
const USER_MESSAGE = '着手可能なチケットを教えて';
const MCP_ENTRY = '/abs/bd-mcp-server-main.ts';
const NODE_EXEC = '/usr/bin/node';
const NODE_EXEC_ARGV = ['--import', 'file:///abs/tsx/loader.mjs'];

interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly input?: string;
    readonly env?: Readonly<Record<string, string>>;
  };
}

function createFakeRunner(options: {
  readonly handler?: (
    command: string,
    args: readonly string[],
  ) => Promise<CommandResult> | CommandResult;
} = {}): {
  readonly runner: CommandRunner;
  readonly calls: RunCall[];
} {
  const calls: RunCall[] = [];

  const runner: CommandRunner = {
    async run(command, args, runOptions) {
      calls.push({
        command,
        args,
        ...(runOptions !== undefined
          ? {
              options: {
                ...(runOptions.cwd !== undefined ? { cwd: runOptions.cwd } : {}),
                ...(runOptions.timeoutMs !== undefined
                  ? { timeoutMs: runOptions.timeoutMs }
                  : {}),
                ...(runOptions.input !== undefined ? { input: runOptions.input } : {}),
                ...(runOptions.env !== undefined ? { env: runOptions.env } : {}),
              },
            }
          : {}),
      });

      if (options.handler) {
        return await options.handler(command, args);
      }

      return {
        stdout: JSON.stringify({
          result: 'ok',
          session_id: 'sess-1',
          is_error: false,
        }),
        stderr: '',
        exitCode: 0,
      };
    },
  };

  return { runner, calls };
}

function createAgent(
  runner: CommandRunner,
  envOverrides: NodeJS.ProcessEnv = {},
) {
  return createClaudeChatAgent(runner, {
    claudePath: '/opt/claude',
    bdPath: 'bd-custom',
    model: 'sonnet',
    mcpServerEntryPath: MCP_ENTRY,
    nodeExecPath: NODE_EXEC,
    nodeExecArgv: NODE_EXEC_ARGV,
    env: {
      PATH: '/bin:/usr/bin',
      HOME: '/home/test',
      ANTHROPIC_API_KEY: 'sk-should-not-leak',
      WP_APP_PASSWORD: 'x',
      ...envOverrides,
    },
  });
}

describe('createClaudeChatAgent', () => {
  it('includes sandbox argv flags', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    const args = calls[0]?.args ?? [];
    expect(args).toContain('--tools');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('allows only mcp__bd__ tools in --allowedTools', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    const args = calls[0]?.args ?? [];
    const allowedToolsIndex = args.indexOf('--allowedTools');
    const allowedTools = args[allowedToolsIndex + 1];
    const expected = CHAT_TOOL_DEFINITIONS.map((tool) => `mcp__bd__${tool.name}`).join(',');

    expect(allowedTools).toBe(expected);
    expect(allowedTools).not.toContain('Bash');
  });

  it('does not include forbidden flags', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    const joined = (calls[0]?.args ?? []).join(' ');
    expect(joined).not.toContain('--dangerously-skip-permissions');
    expect(joined).not.toContain('--allow-dangerously-skip-permissions');
    expect(joined).not.toContain('bypassPermissions');
    expect(joined).not.toContain('--add-dir');
  });

  it('passes user message via stdin input, not argv', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    expect(calls[0]?.options?.input).toBe(USER_MESSAGE);
    expect(calls[0]?.args.includes(USER_MESSAGE)).toBe(false);
  });

  it('uses projectRootPath as cwd', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    expect(calls[0]?.options?.cwd).toBe(PROJECT_ROOT);
  });

  it('filters env to the allowlist and drops secrets', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    const env = calls[0]?.options?.env ?? {};
    expect(env.PATH).toBe('/bin:/usr/bin');
    expect(env.HOME).toBe('/home/test');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.WP_APP_PASSWORD).toBeUndefined();
    expect(env.CI).toBeUndefined();
  });

  it('embeds project root in mcp-config args', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    const args = calls[0]?.args ?? [];
    const mcpConfigIndex = args.indexOf('--mcp-config');
    const mcpConfig = JSON.parse(args[mcpConfigIndex + 1] ?? '{}') as {
      mcpServers: { bd: { command: string; args: string[] } };
    };

    expect(mcpConfig.mcpServers.bd.command).toBe(NODE_EXEC);
    expect(mcpConfig.mcpServers.bd.args).toEqual([
      ...NODE_EXEC_ARGV,
      MCP_ENTRY,
      '--project-root',
      PROJECT_ROOT,
      '--bd-path',
      'bd-custom',
    ]);
  });

  it('adds --resume when resumeSessionId is provided', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
      resumeSessionId: 'session-abc',
    });

    const args = calls[0]?.args ?? [];
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('session-abc');
  });

  it('omits --resume when resumeSessionId is absent', async () => {
    const { runner, calls } = createFakeRunner();
    const agent = createAgent(runner);

    await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    expect(calls[0]?.args.includes('--resume')).toBe(false);
  });

  it('parses successful claude JSON output', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          result: 'こんにちは',
          session_id: 'sess-xyz',
          is_error: false,
        }),
        stderr: '',
        exitCode: 0,
      }),
    });
    const agent = createAgent(runner);

    const result = await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    expect(result).toEqual({
      reply: 'こんにちは',
      sessionId: 'sess-xyz',
      failedTools: [],
      agentId: 'claude',
      model: 'sonnet',
    });
  });

  it('returns failedTools from permission_denials even when is_error is true', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          result: '拒否されました',
          session_id: 'sess-deny',
          is_error: true,
          permission_denials: [{ tool_name: 'mcp__bd__bd_close' }],
        }),
        stderr: '',
        exitCode: 0,
      }),
    });
    const agent = createAgent(runner);

    const result = await agent.sendMessage({
      projectRootPath: PROJECT_ROOT,
      projectName: PROJECT_NAME,
      message: USER_MESSAGE,
    });

    expect(result.reply).toBe('拒否されました');
    expect(result.failedTools).toEqual(['mcp__bd__bd_close']);
  });

  it('throws ChatAgentError on non-zero exit', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: '',
        stderr: 'boom',
        exitCode: 2,
      }),
    });
    const agent = createAgent(runner);

    await expect(
      agent.sendMessage({
        projectRootPath: PROJECT_ROOT,
        projectName: PROJECT_NAME,
        message: USER_MESSAGE,
      }),
    ).rejects.toMatchObject({
      code: 'agent-exit-nonzero',
      detail: CHAT_FAILURE_MESSAGES['agent-exit-nonzero'],
    });
  });

  it('throws ChatAgentError on invalid JSON output', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: 'not-json',
        stderr: '',
        exitCode: 0,
      }),
    });
    const agent = createAgent(runner);

    await expect(
      agent.sendMessage({
        projectRootPath: PROJECT_ROOT,
        projectName: PROJECT_NAME,
        message: USER_MESSAGE,
      }),
    ).rejects.toMatchObject({
      code: 'agent-bad-output',
      detail: CHAT_FAILURE_MESSAGES['agent-bad-output'],
    });
  });

  it('throws ChatAgentError on unexpected output shape', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({ foo: 'bar' }),
        stderr: '',
        exitCode: 0,
      }),
    });
    const agent = createAgent(runner);

    await expect(
      agent.sendMessage({
        projectRootPath: PROJECT_ROOT,
        projectName: PROJECT_NAME,
        message: USER_MESSAGE,
      }),
    ).rejects.toMatchObject({
      code: 'agent-unexpected-output',
      detail: CHAT_FAILURE_MESSAGES['agent-unexpected-output'],
    });
  });

  it('checkAvailability probes claude auth status instead of --version', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, _args) => ({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
        stderr: '',
        exitCode: 0,
      }),
    });
    const agent = createAgent(runner);

    await expect(agent.checkAvailability()).resolves.toBe('available');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['auth', 'status', '--json']);
  });

  it("checkAvailability reports 'unavailable' when the claude CLI is installed but not logged in", async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: JSON.stringify({
          loggedIn: false,
          authMethod: 'none',
          apiProvider: 'firstParty',
        }),
        stderr: '',
        exitCode: 1,
      }),
    });
    const agent = createAgent(runner);

    await expect(agent.checkAvailability()).resolves.toBe('unavailable');
  });
});
