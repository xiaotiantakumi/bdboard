import type { CommandRunner, CommandRunOptions } from '../../application/ports/command-runner.js';
import {
  CHAT_TOOL_DEFINITIONS,
  buildChatToolCommand,
} from './chat-tool-catalog.js';
import { applyRepoOutputFilter } from './repo-tool-catalog.js';
import { isDeployStatusToolName, runDeployStatusTool } from './deploy-status-tool.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_GIT_PATH = 'git';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SUCCESS_OUTPUT_CHARS = 60_000;

export interface BdMcpServerDeps {
  readonly commandRunner: CommandRunner;
  readonly projectRootPath: string;
  readonly bdPath?: string;
  /**
   * git の実行パス。既定は PATH 上の `git`。CLI からは渡らない
   * (bd-mcp-server-main.ts に --git-path は無い) が、テストが本物の git を
   * 起動せずに配線を確かめられるようにここだけ差し替え可能にしてある。
   */
  readonly gitPath?: string;
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
    tools: CHAT_TOOL_DEFINITIONS.map((tool) => ({
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
  const gitPath = deps.gitPath ?? DEFAULT_GIT_PATH;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function handleToolsCall(params: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(params) || typeof params.name !== 'string') {
      return createToolErrorResult('invalid params');
    }

    // deploy_status(bdboard-3tw.159.5)は fs読み取り+複数の git 呼び出しを
    // 組み合わせる必要があり、他ツール共通の「単一コマンドを組み立てて1回だけ
    // 実行する」モデル(buildChatToolCommand)に乗らないため、ここで先に分岐する。
    if (isDeployStatusToolName(params.name)) {
      return runDeployStatusTool({
        commandRunner: deps.commandRunner,
        projectRootPath: deps.projectRootPath,
        gitPath,
        timeoutMs,
      });
    }

    const built = buildChatToolCommand(
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

    const executablePath = built.executable === 'git' ? gitPath : bdPath;
    const result = await deps.commandRunner.run(
      executablePath,
      built.args,
      runOptions,
    );

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

    // 絞り込みは切り詰めより先に行う。ls-tree の全件列挙を先に切ると、
    // 「本当に無い」と「上限で切れて見えていないだけ」が区別できなくなる。
    const stdout =
      built.outputFilter !== undefined
        ? applyRepoOutputFilter(result.stdout, built.outputFilter)
        : result.stdout;

    return {
      content: [
        {
          type: 'text',
          text: truncate(stdout, MAX_SUCCESS_OUTPUT_CHARS),
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
