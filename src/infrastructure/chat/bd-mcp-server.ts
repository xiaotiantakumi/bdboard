import type { CommandRunner, CommandRunOptions } from '../../application/ports/command-runner.js';
import { BD_TOOL_DEFINITIONS, buildBdToolArgs } from './bd-tool-catalog.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SUCCESS_OUTPUT_CHARS = 60_000;

export interface BdMcpServerDeps {
  readonly commandRunner: CommandRunner;
  readonly projectRootPath: string;
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

export interface BdMcpServer {
  /** JSON-RPCメッセージを1件処理。通知(idなし)は null を返す。 */
  handleMessage(message: unknown): Promise<Record<string, unknown> | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotification(message: Record<string, unknown>): boolean {
  return !('id' in message);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function summarizeCommandFailure(stdout: string, stderr: string): string {
  const parts = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0);
  if (parts.length === 0) {
    return 'command failed';
  }
  return parts.join('\n');
}

function createResultResponse(
  id: unknown,
  result: unknown,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function createErrorResponse(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

function handleInitialize(params: unknown): Record<string, unknown> {
  const requestedProtocolVersion =
    isRecord(params) && typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : undefined;

  return {
    protocolVersion: requestedProtocolVersion ?? '2025-06-18',
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'bd',
      version: '0.1.0',
    },
  };
}

function handleToolsList(): Record<string, unknown> {
  return {
    tools: BD_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
}

function createToolErrorResult(error: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: `rejected: ${error}` }],
    isError: true,
  };
}

export function createBdMcpServer(deps: BdMcpServerDeps): BdMcpServer {
  const bdPath = deps.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function handleToolsCall(params: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(params) || typeof params.name !== 'string') {
      return createToolErrorResult('invalid params');
    }

    const built = buildBdToolArgs(
      params.name,
      params.arguments ?? {},
      deps.projectRootPath,
    );

    if (!built.ok) {
      return createToolErrorResult(built.error);
    }

    const runOptions: CommandRunOptions = {
      cwd: deps.projectRootPath,
      timeoutMs,
      ...(built.stdin !== undefined ? { input: built.stdin } : {}),
    };

    const result = await deps.commandRunner.run(bdPath, built.args, runOptions);

    if (result.exitCode !== 0) {
      return {
        content: [
          {
            type: 'text',
            text: summarizeCommandFailure(result.stdout, result.stderr),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: truncate(result.stdout, MAX_SUCCESS_OUTPUT_CHARS),
        },
      ],
      isError: false,
    };
  }

  return {
    async handleMessage(message: unknown): Promise<Record<string, unknown> | null> {
      if (!isRecord(message) || typeof message.method !== 'string') {
        if (isRecord(message) && !isNotification(message)) {
          return createErrorResponse(message.id, -32600, 'Invalid Request');
        }
        return null;
      }

      const method = message.method;
      const notification = isNotification(message);

      if (method === 'notifications/initialized') {
        return null;
      }

      if (notification) {
        return null;
      }

      const id = message.id;

      switch (method) {
        case 'initialize':
          return createResultResponse(id, handleInitialize(message.params));
        case 'tools/list':
          return createResultResponse(id, handleToolsList());
        case 'tools/call':
          return createResultResponse(id, await handleToolsCall(message.params));
        default:
          return createErrorResponse(id, -32601, `Method not found: ${method}`);
      }
    },
  };
}
