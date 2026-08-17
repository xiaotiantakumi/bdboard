import path from 'node:path';

export interface McpClientConfigInput {
  /** MCP サーバー名。既定 'bd' */
  readonly serverName?: string;
  /** node 実行ファイルの絶対パス (v22 以上) */
  readonly nodeExecPath: string;
  /** tsx CLI の絶対パス */
  readonly tsxCliPath: string;
  /** bd-mcp-server-main.ts の絶対パス */
  readonly serverEntryPath: string;
  /** bd プロジェクトルートの絶対パス */
  readonly projectRootPath: string;
  /** bd バイナリ。既定 'bd' */
  readonly bdPath?: string;
}

export interface McpClientConfigs {
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Claude Code の .mcp.json / --mcp-config に貼る整形済み JSON */
  readonly claudeCodeJson: string;
  /** `codex mcp add ...` のワンライナー */
  readonly codexAddCommand: string;
  /** ~/.codex/config.toml に直書きする場合の [mcp_servers.<name>] ブロック */
  readonly codexConfigToml: string;
  /** .cursor/mcp.json に貼る整形済み JSON */
  readonly cursorJson: string;
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNQUOTED_SHELL_TOKEN_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

const ABSOLUTE_PATH_FIELDS: ReadonlyArray<{
  readonly key: keyof Pick<
    McpClientConfigInput,
    'nodeExecPath' | 'tsxCliPath' | 'serverEntryPath' | 'projectRootPath'
  >;
  readonly label: string;
}> = [
  { key: 'nodeExecPath', label: 'nodeExecPath' },
  { key: 'tsxCliPath', label: 'tsxCliPath' },
  { key: 'serverEntryPath', label: 'serverEntryPath' },
  { key: 'projectRootPath', label: 'projectRootPath' },
];

function assertAbsolutePath(value: string, fieldName: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${fieldName} must be an absolute path: ${value}`);
  }
}

function assertServerName(serverName: string): void {
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`serverName must match ${SERVER_NAME_PATTERN.source}: ${serverName}`);
  }
}

function shellQuoteToken(token: string): string {
  if (UNQUOTED_SHELL_TOKEN_PATTERN.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatTomlString(value: string): string {
  return `"${escapeTomlString(value)}"`;
}

function buildMcpServersJson(
  serverName: string,
  command: string,
  args: readonly string[],
): { mcpServers: Record<string, { command: string; args: readonly string[] }> } {
  return {
    mcpServers: {
      [serverName]: {
        command,
        args,
      },
    },
  };
}

/**
 * node を明示的に絶対パスで指定するのが重要。素の shell の node が古い場合、
 * tsx の shebang (#!/usr/bin/env node) 経由だと意図しないバージョンが選ばれて壊れる。
 */
export function buildMcpClientConfigs(input: McpClientConfigInput): McpClientConfigs {
  const serverName = input.serverName ?? 'bd';
  const bdPath = input.bdPath ?? 'bd';

  assertServerName(serverName);
  for (const field of ABSOLUTE_PATH_FIELDS) {
    assertAbsolutePath(input[field.key], field.label);
  }

  const command = input.nodeExecPath;
  const args: readonly string[] = [
    input.tsxCliPath,
    input.serverEntryPath,
    '--project-root',
    input.projectRootPath,
    '--bd-path',
    bdPath,
  ];

  const mcpServersObj = buildMcpServersJson(serverName, command, args);
  const claudeCodeJson = JSON.stringify(mcpServersObj, null, 2);
  const cursorJson = JSON.stringify(mcpServersObj, null, 2);

  const quotedCommand = shellQuoteToken(command);
  const quotedArgs = args.map(shellQuoteToken).join(' ');
  const codexAddCommand = `codex mcp add ${serverName} -- ${quotedCommand} ${quotedArgs}`;

  const tomlArgs = args.map((arg) => formatTomlString(arg)).join(', ');
  const codexConfigToml = `[mcp_servers.${serverName}]\ncommand = ${formatTomlString(command)}\nargs = [${tomlArgs}]\n`;

  return {
    serverName,
    command,
    args,
    claudeCodeJson,
    codexAddCommand,
    codexConfigToml,
    cursorJson,
  };
}
