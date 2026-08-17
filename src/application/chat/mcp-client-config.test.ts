import { describe, expect, it } from 'vitest';
import type { McpClientConfigInput } from './mcp-client-config.js';
import { buildMcpClientConfigs } from './mcp-client-config.js';

const BASE_INPUT: McpClientConfigInput = {
  nodeExecPath: '/usr/local/bin/node',
  tsxCliPath: '/repo/node_modules/tsx/dist/cli.mjs',
  serverEntryPath: '/repo/src/infrastructure/chat/bd-mcp-server-main.ts',
  projectRootPath: '/home/user/projects/bdboard',
};

function build(overrides: Partial<McpClientConfigInput> = {}) {
  return buildMcpClientConfigs({ ...BASE_INPUT, ...overrides });
}

describe('buildMcpClientConfigs', () => {
  it('builds claude/cursor JSON with expected command and args order', () => {
    const configs = build();

    const claude = JSON.parse(configs.claudeCodeJson) as {
      mcpServers: { bd: { command: string; args: string[] } };
    };
    const cursor = JSON.parse(configs.cursorJson) as {
      mcpServers: { bd: { command: string; args: string[] } };
    };

    const expectedArgs = [
      '/repo/node_modules/tsx/dist/cli.mjs',
      '/repo/src/infrastructure/chat/bd-mcp-server-main.ts',
      '--project-root',
      '/home/user/projects/bdboard',
      '--bd-path',
      'bd',
    ];

    expect(configs.command).toBe('/usr/local/bin/node');
    expect(configs.args).toEqual(expectedArgs);
    expect(claude.mcpServers.bd.command).toBe('/usr/local/bin/node');
    expect(claude.mcpServers.bd.args).toEqual(expectedArgs);
    expect(cursor.mcpServers.bd.command).toBe('/usr/local/bin/node');
    expect(cursor.mcpServers.bd.args).toEqual(expectedArgs);
  });

  it('reflects custom serverName across all outputs', () => {
    const configs = build({ serverName: 'beads-board' });

    const claude = JSON.parse(configs.claudeCodeJson) as {
      mcpServers: Record<string, unknown>;
    };
    const cursor = JSON.parse(configs.cursorJson);
    expect(configs.serverName).toBe('beads-board');
    expect(Object.keys(claude.mcpServers)).toEqual(['beads-board']);
    expect(configs.codexAddCommand.startsWith('codex mcp add beads-board -- ')).toBe(true);
    expect(configs.codexConfigToml).toContain('[mcp_servers.beads-board]');
    expect(cursor).toEqual(claude);
  });

  it('defaults bdPath to bd when omitted', () => {
    const configs = build();
    expect(configs.args).toContain('bd');
    expect(configs.args[configs.args.length - 1]).toBe('bd');
  });

  it('starts codexAddCommand with codex mcp add bd --', () => {
    const configs = build();
    expect(configs.codexAddCommand.startsWith('codex mcp add bd -- ')).toBe(true);
  });

  it('shell-quotes paths with spaces in codexAddCommand and escapes them in codexConfigToml', () => {
    const configs = build({
      nodeExecPath: '/Users/me/.nvm/versions/node/v22.0.0/bin/node',
      projectRootPath: '/Users/me/My Projects/bdboard',
    });

    expect(configs.codexAddCommand).toContain(
      "'/Users/me/My Projects/bdboard'",
    );
    expect(configs.codexConfigToml).toContain('"/Users/me/My Projects/bdboard"');
  });

  it('escapes single quotes in paths for codexAddCommand', () => {
    const configs = build({
      projectRootPath: "/Users/me/o'reilly/bdboard",
    });

    expect(configs.codexAddCommand).toContain("'/Users/me/o'\\''reilly/bdboard'");
    expect(configs.codexConfigToml).toContain('"/Users/me/o\'reilly/bdboard"');
  });

  it.each([
    ['nodeExecPath', { nodeExecPath: 'relative/node' }],
    ['tsxCliPath', { tsxCliPath: 'node_modules/tsx/dist/cli.mjs' }],
    ['serverEntryPath', { serverEntryPath: 'src/infrastructure/chat/bd-mcp-server-main.ts' }],
    ['projectRootPath', { projectRootPath: './bdboard' }],
  ] as const)('throws when %s is not absolute', (fieldName, override: Partial<McpClientConfigInput>) => {
    expect(() => build(override)).toThrow(`${fieldName} must be an absolute path`);
  });

  it.each(['bd bad', 'bd;rm'])('throws for invalid serverName %j', (serverName) => {
    expect(() => build({ serverName })).toThrow('serverName must match');
  });

  it('does not include env key in generated JSON', () => {
    const configs = build();
    expect(configs.claudeCodeJson).not.toContain('"env"');
    expect(configs.cursorJson).not.toContain('"env"');

    const claude = JSON.parse(configs.claudeCodeJson) as Record<string, unknown>;
    const cursor = JSON.parse(configs.cursorJson) as Record<string, unknown>;
    expect(claude).not.toHaveProperty('env');
    expect(cursor).not.toHaveProperty('env');
    expect(claude.mcpServers).toBeDefined();
    for (const server of Object.values(claude.mcpServers as Record<string, Record<string, unknown>>)) {
      expect(server).not.toHaveProperty('env');
    }
  });
});
