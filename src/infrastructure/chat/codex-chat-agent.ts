import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { ChatAgentPort, ChatTurnRequest } from '../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { CHAT_TOOL_DEFINITIONS } from './chat-tool-catalog.js';
import { buildBdSystemPrompt } from './bd-system-prompt.js';
import { createCliChatAgent } from './cli-chat-agent.js';
import { createCodexSpec } from './specs/codex-spec.js';

const DEFAULT_CODEX_PATH = 'codex';
const DEFAULT_BD_PATH = 'bd';
const DEFAULT_MODEL = '';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MCP_SERVER_ENTRY_PATH = fileURLToPath(
  new URL('./bd-mcp-server-main.ts', import.meta.url),
);

export interface CodexChatAgentOptions {
  readonly codexPath?: string;
  readonly bdPath?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly mcpServerEntryPath?: string;
  readonly nodeExecPath?: string;
  readonly nodeExecArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

interface ResolvedCodexChatAgentOptions {
  readonly codexPath: string;
  readonly bdPath: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly mcpServerEntryPath: string;
  readonly nodeExecPath: string;
  readonly nodeExecArgv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function resolveOptions(options?: CodexChatAgentOptions): ResolvedCodexChatAgentOptions {
  return {
    codexPath: options?.codexPath ?? process.env.BDBOARD_CODEX_PATH ?? DEFAULT_CODEX_PATH,
    bdPath: options?.bdPath ?? DEFAULT_BD_PATH,
    model: options?.model ?? DEFAULT_MODEL,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    mcpServerEntryPath: options?.mcpServerEntryPath ?? DEFAULT_MCP_SERVER_ENTRY_PATH,
    nodeExecPath: options?.nodeExecPath ?? process.execPath,
    nodeExecArgv: options?.nodeExecArgv ?? process.execArgv,
    env: options?.env ?? process.env,
  };
}

/**
 * codex-chat-agent.ts / claude-chat-agent.ts はほぼ同型だが、buildContext に渡す
 * capability だけが 'unrestricted' vs 'bd-only' で異なる。ここが唯一、両アダプタの
 * 実際のツール権限差(shell/ファイル読み書きが使えるか)を bd-system-prompt と
 * ChatAgentDescriptor に伝える箇所なので、コピペで揃えたくなっても capability の値
 * だけは絶対に揃えないこと(揃えると codex 側が「bd 以外は何もできない」と嘘をつく)。
 * 権限差そのものの是非は bdboard-9a9 の裁定で決着済み — このファイルはそれを
 * 正直に反映するだけで、新たな制限を足す場所ではない。
 */
export function createCodexChatAgent(
  commandRunner: CommandRunner,
  options?: CodexChatAgentOptions,
): ChatAgentPort {
  const resolved = resolveOptions(options);
  const spec = createCodexSpec({
    codexPath: resolved.codexPath,
    model: resolved.model,
    timeoutMs: resolved.timeoutMs,
  });

  return createCliChatAgent(commandRunner, spec, {
    env: resolved.env,
    buildContext(request: ChatTurnRequest) {
      return {
        systemPrompt: buildBdSystemPrompt({
          projectName: request.projectName,
          projectRootPath: request.projectRootPath,
          capability: 'unrestricted',
        }),
        mcpServers: [
          {
            name: 'bd',
            command: resolved.nodeExecPath,
            args: [
              ...resolved.nodeExecArgv,
              resolved.mcpServerEntryPath,
              '--project-root',
              request.projectRootPath,
              '--bd-path',
              resolved.bdPath,
            ],
          },
        ],
        toolNames: CHAT_TOOL_DEFINITIONS.map((tool) => tool.name),
        scratchDir: os.tmpdir(),
      };
    },
  });
}
