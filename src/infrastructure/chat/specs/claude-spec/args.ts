import type { ChatTurnRequest } from '../../../../application/ports/chat-agent.js';
import type { CliMcpServerSpec, CliTurnContext } from '../../cli-chat-agent.js';

function buildAllowedToolsValue(toolNames: readonly string[]): string {
  return toolNames.map((name) => `mcp__bd__${name}`).join(',');
}

function buildMcpConfigJson(mcpServers: readonly CliMcpServerSpec[]): string {
  const servers: Record<string, { command: string; args: string[] }> = {};
  for (const server of mcpServers) {
    servers[server.name] = {
      command: server.command,
      args: [...server.args],
    };
  }

  return JSON.stringify({ mcpServers: servers });
}

export function buildClaudeArgs(
  request: ChatTurnRequest,
  ctx: CliTurnContext,
  model: string,
): string[] {
  const mcpConfig = buildMcpConfigJson(ctx.mcpServers);

  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--system-prompt',
    ctx.systemPrompt,
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--allowedTools',
    buildAllowedToolsValue(ctx.toolNames),
    '--setting-sources',
    '',
  ];

  if (request.resumeSessionId !== undefined) {
    args.push('--resume', request.resumeSessionId);
  }

  return args;
}

export function buildStreamingClaudeArgs(
  request: ChatTurnRequest,
  ctx: CliTurnContext,
  model: string,
): string[] {
  const args = buildClaudeArgs(request, ctx, model);
  // bdboard-l1t.9 Opus レビュー N1: args.indexOf('json') は値の中身で検索していて、
  // 将来 'json' という文字列を持つ別の引数(モデル名やメッセージ本文由来)が
  // 紛れ込むと誤検出しうる脆い実装だった。--output-format フラグの「次の要素」を
  // 位置で特定する方が堅い。
  const outputFormatFlagIndex = args.indexOf('--output-format');
  if (outputFormatFlagIndex === -1 || outputFormatFlagIndex + 1 >= args.length) {
    throw new Error('buildClaudeArgs did not include --output-format');
  }
  args.splice(outputFormatFlagIndex + 1, 1, 'stream-json', '--include-partial-messages', '--verbose');
  return args;
}
