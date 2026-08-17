import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { ChatAgentPort, ChatTurnRequest } from '../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { StreamingCommandRunner } from '../../application/ports/streaming-command-runner.js';
import { BD_TOOL_DEFINITIONS } from './bd-tool-catalog.js';
import { buildBdSystemPrompt } from './bd-system-prompt.js';
import { createCliChatAgent } from './cli-chat-agent.js';
import { createClaudeSpec, type ClaudeModelWeights } from './specs/claude-spec.js';

const DEFAULT_CLAUDE_PATH = 'claude';
const DEFAULT_BD_PATH = 'bd';
const DEFAULT_MODEL = 'sonnet';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MCP_SERVER_ENTRY_PATH = fileURLToPath(
  new URL('./bd-mcp-server-main.ts', import.meta.url),
);

export interface ClaudeChatAgentOptions {
  readonly claudePath?: string;
  readonly bdPath?: string;
  readonly model?: string;
  readonly modelWeights?: ClaudeModelWeights;
  readonly timeoutMs?: number;
  readonly mcpServerEntryPath?: string;
  readonly nodeExecPath?: string;
  readonly nodeExecArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

interface ResolvedClaudeChatAgentOptions {
  readonly claudePath: string;
  readonly bdPath: string;
  readonly model: string;
  readonly modelWeights?: ClaudeModelWeights;
  readonly timeoutMs: number;
  readonly mcpServerEntryPath: string;
  readonly nodeExecPath: string;
  readonly nodeExecArgv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

function resolveOptions(options?: ClaudeChatAgentOptions): ResolvedClaudeChatAgentOptions {
  return {
    claudePath:
      options?.claudePath ?? process.env.BDBOARD_CLAUDE_PATH ?? DEFAULT_CLAUDE_PATH,
    bdPath: options?.bdPath ?? DEFAULT_BD_PATH,
    model: options?.model ?? DEFAULT_MODEL,
    modelWeights: options?.modelWeights,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    mcpServerEntryPath: options?.mcpServerEntryPath ?? DEFAULT_MCP_SERVER_ENTRY_PATH,
    nodeExecPath: options?.nodeExecPath ?? process.execPath,
    nodeExecArgv: options?.nodeExecArgv ?? process.execArgv,
    env: options?.env ?? process.env,
  };
}

export function createClaudeChatAgent(
  commandRunner: CommandRunner,
  options?: ClaudeChatAgentOptions,
  streamingCommandRunner?: StreamingCommandRunner,
): ChatAgentPort {
  const resolved = resolveOptions(options);
  const spec = createClaudeSpec({
    claudePath: resolved.claudePath,
    model: resolved.model,
    modelWeights: resolved.modelWeights,
    timeoutMs: resolved.timeoutMs,
  });

  return createCliChatAgent(commandRunner, spec, {
    env: resolved.env,
    ...(streamingCommandRunner !== undefined ? { streamingCommandRunner } : {}),
    buildContext(request: ChatTurnRequest) {
      return {
        systemPrompt: buildBdSystemPrompt({
          projectName: request.projectName,
          projectRootPath: request.projectRootPath,
          capability: 'bd-only',
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
        toolNames: BD_TOOL_DEFINITIONS.map((tool) => tool.name),
        scratchDir: os.tmpdir(),
      };
    },
  });
}
