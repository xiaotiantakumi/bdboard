import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { CHAT_TOOL_DEFINITIONS } from './chat-tool-catalog.js';
import { createBdMcpServer } from './bd-mcp-server.js';

const PROJECT_ROOT = '/tmp/bdboard-mcp-test';

interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly input?: string;
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
              },
            }
          : {}),
      });

      if (options.handler) {
        return await options.handler(command, args);
      }

      return { stdout: '[]', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

describe('createBdMcpServer', () => {
  it('handles initialize with default protocol version', async () => {
    const { runner } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'bd', version: '0.1.0' },
      },
    });
  });

  it('uses requested protocol version on initialize', async () => {
    const { runner } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });

    expect(response?.result).toMatchObject({
      protocolVersion: '2024-11-05',
    });
  });

  it('returns null for notifications/initialized', async () => {
    const { runner } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response).toBeNull();
  });

  it('lists bd tools without Bash or other built-ins', async () => {
    const { runner } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });

    const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(
      CHAT_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    expect(tools.some((tool) => tool.name === 'Bash')).toBe(false);
  });

  it('calls CommandRunner for valid tools/call', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async () => ({
        stdout: '{"id":"x"}',
        stderr: '',
        exitCode: 0,
      }),
    });
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      bdPath: '/usr/local/bin/bd',
      timeoutMs: 12_345,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'bd_show',
        arguments: { id: 'bdboard-1' },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: '/usr/local/bin/bd',
      args: [
        '--readonly',
        '-C',
        PROJECT_ROOT,
        'show',
        '--json',
        '--include-comments',
        '--id=bdboard-1',
      ],
      options: {
        cwd: PROJECT_ROOT,
        timeoutMs: 12_345,
      },
    });
    expect(response?.result).toEqual({
      content: [{ type: 'text', text: '{"id":"x"}' }],
      isError: false,
    });
  });

  it('passes stdin to CommandRunner for bd_comment', async () => {
    const { runner, calls } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'bd_comment',
        arguments: { id: 'bdboard-1', text: '進捗メモ' },
      },
    });

    expect(calls[0]?.options?.input).toBe('進捗メモ');
  });

  it('does not call CommandRunner for unknown tools', async () => {
    const { runner, calls } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'bash',
        arguments: {},
      },
    });

    expect(calls).toHaveLength(0);
    expect(response?.result).toEqual({
      content: [{ type: 'text', text: 'rejected: unknown tool: bash' }],
      isError: true,
    });
  });

  it('does not call CommandRunner for invalid arguments', async () => {
    const { runner, calls } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'bd_show',
        arguments: { id: '-rf' },
      },
    });

    expect(calls).toHaveLength(0);
    expect(response?.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringMatching(/^rejected: /) }],
    });
  });

  it('returns isError when bd exits non-zero', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: 'stdout detail',
        stderr: 'stderr detail',
        exitCode: 1,
      }),
    });
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'bd_list',
        arguments: {},
      },
    });

    expect(response?.result).toEqual({
      content: [{ type: 'text', text: 'stderr detail\nstdout detail' }],
      isError: true,
    });
  });

  it('truncates successful stdout to 60000 characters', async () => {
    const longOutput = 'x'.repeat(70_000);
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: longOutput,
        stderr: '',
        exitCode: 0,
      }),
    });
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'bd_list',
        arguments: {},
      },
    });

    const text = (
      response?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    expect(text).toHaveLength(60_000);
    expect(text).toBe('x'.repeat(60_000));
  });

  it('returns -32601 for unknown methods', async () => {
    const { runner } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 10,
      method: 'resources/list',
    });

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 10,
      error: {
        code: -32601,
        message: 'Method not found: resources/list',
      },
    });
  });
});

describe('createBdMcpServer / repo evidence tools (bdboard-3tw.159.4)', () => {
  it('runs git (not bd) for repo_ticket_landed', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async () => ({
        stdout: 'be5f58e 2026-08-28 fix(bdboard-3tw.151): drop sync health\n',
        stderr: '',
        exitCode: 0,
      }),
    });
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      bdPath: '/opt/bd',
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'repo_ticket_landed',
        arguments: { ticketId: 'bdboard-3tw.151' },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('git');
    expect(calls[0]?.args).toContain('--grep=bdboard-3tw.151');
    expect(calls[0]?.options?.cwd).toBe(PROJECT_ROOT);
    expect(response?.result).toMatchObject({ isError: false });
  });

  it('uses the configured git path', async () => {
    const { runner, calls } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      gitPath: '/usr/local/bin/git',
    });

    await server.handleMessage({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'repo_ticket_landed', arguments: { ticketId: 'bdboard-x32' } },
    });

    expect(calls[0]?.command).toBe('/usr/local/bin/git');
  });

  it('filters the ls-tree output instead of returning the whole tree', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        // git は各行を改行で終える。末尾の改行が無い出力は「途中で切れた」の合図
        // として扱われるので、フェイクでも本物どおり終端しておく。
        stdout: `${['src/main.ts', 'web/src/SyncHealth.tsx', 'README.md'].join('\n')}\n`,
        stderr: '',
        exitCode: 0,
      }),
    });
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'repo_path_exists', arguments: { pattern: 'syncHEALTH' } },
    });

    const text = (
      response?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;

    // 大文字小文字を無視して1件だけ当たり、無関係なパスは返らない。
    expect(text).toBe('matched=1 scanned=3\nweb/src/SyncHealth.tsx');
    expect(text).not.toContain('README.md');
  });

  it('reports matched=0 for a path that is really gone', async () => {
    const { runner } = createFakeRunner({
      handler: async () => ({
        stdout: `${['src/main.ts', 'README.md'].join('\n')}\n`,
        stderr: '',
        exitCode: 0,
      }),
    });
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: { name: 'repo_path_exists', arguments: { pattern: 'sync-health' } },
    });

    expect(
      (response?.result as { content: Array<{ text: string }> }).content[0]?.text,
    ).toBe('matched=0 scanned=2');
  });

  it('filters before truncating so a match past the 60k cap still shows', async () => {
    // 大きなリポジトリでは ls-tree の全件列挙が出力上限を軽く超える。先に切ると
    // 「当たりが上限の外にあった」のと「本当に無い」が区別できなくなるので、
    // 絞り込みが先であることを固定する。
    const filler = Array.from({ length: 4000 }, (_, index) => `src/filler-${index}.ts`);
    const stdout = `${[...filler, 'web/src/SyncHealth.tsx'].join('\n')}\n`;
    expect(stdout.length).toBeGreaterThan(60_000);

    const { runner } = createFakeRunner({
      handler: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 26,
      method: 'tools/call',
      params: { name: 'repo_path_exists', arguments: { pattern: 'synchealth' } },
    });

    expect(
      (response?.result as { content: Array<{ text: string }> }).content[0]?.text,
    ).toBe('matched=1 scanned=4001\nweb/src/SyncHealth.tsx');
  });

  it('rejects a repo tool with an invalid ref without running anything', async () => {
    const { runner, calls } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'repo_ticket_landed',
        arguments: { ticketId: 'bdboard-x32', ref: '--upload-pack=sh' },
      },
    });

    expect(calls).toHaveLength(0);
    expect(response?.result).toMatchObject({ isError: true });
  });

  it('never exposes a git write tool', async () => {
    const { runner, calls } = createFakeRunner();
    const server = createBdMcpServer({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
    });

    for (const name of ['repo_push', 'repo_commit', 'git', 'repo_checkout']) {
      const response = await server.handleMessage({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: { name, arguments: {} },
      });
      expect(response?.result).toMatchObject({ isError: true });
    }

    expect(calls).toHaveLength(0);
  });
});
