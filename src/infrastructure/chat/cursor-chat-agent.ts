import os from 'node:os';
import type { ChatAgentPort, ChatTurnRequest } from '../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { buildBdSystemPrompt } from './bd-system-prompt.js';
import { createCliChatAgent } from './cli-chat-agent.js';
import { createCursorSpec } from './specs/cursor-spec.js';

const DEFAULT_CURSOR_PATH = 'cursor-agent';
const DEFAULT_BD_PATH = 'bd';
const DEFAULT_MODEL = '';
const DEFAULT_TIMEOUT_MS = 180_000;

export interface CursorChatAgentOptions {
  readonly cursorPath?: string;
  readonly bdPath?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

interface ResolvedCursorChatAgentOptions {
  readonly cursorPath: string;
  readonly bdPath: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}

function resolveOptions(options?: CursorChatAgentOptions): ResolvedCursorChatAgentOptions {
  return {
    cursorPath: options?.cursorPath ?? process.env.BDBOARD_CURSOR_PATH ?? DEFAULT_CURSOR_PATH,
    // bdboard-l1t.5 Opus レビュー MF2: 他の *-chat-agent.ts(claude/codex)と同様、
    // BDBOARD_BD_PATH を経路として通す。cursor アダプタには bd MCP ツールが無いため
    // bdPath 自体は MCP サーバー起動には使わないが、システムプロンプトが案内する
    // 「シェルで直接呼ぶ bd コマンド」の実体として使う(bd-system-prompt.ts 参照)。
    bdPath: options?.bdPath ?? DEFAULT_BD_PATH,
    model: options?.model ?? DEFAULT_MODEL,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options?.env ?? process.env,
  };
}

/**
 * codex-chat-agent.ts / claude-chat-agent.ts と違い、ここでは bd MCP サーバーを
 * 一切配線しない(mcpServers: [] / toolNames: [])。cursor-agent CLI には
 * ターン単位で MCP サーバーを注入する手段が無いため(詳細は
 * specs/cursor-spec.ts のコメントを参照)、bd ツールを渡す/渡したふりをする
 * ことが構造的にできない。buildBdSystemPrompt に hasBdTools: false を渡し、
 * システムプロンプト自体にも「bd ツールは無い、bd 操作は `bd` CLI をシェルから
 * 直接叩け」と正直に書く(bdboard-l1t.5)。
 *
 * capability は codex と同じ 'unrestricted'(--print が write/shell を含む
 * 全ツールへアクセスできることの正直な申告)。この権限の広さ自体の是非は
 * bdboard-9a9 の裁定で決着済みで、ここはそれを反映するだけ。
 */
export function createCursorChatAgent(
  commandRunner: CommandRunner,
  options?: CursorChatAgentOptions,
): ChatAgentPort {
  const resolved = resolveOptions(options);
  const spec = createCursorSpec({
    cursorPath: resolved.cursorPath,
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
          hasBdTools: false,
          bdPath: resolved.bdPath,
          shellToolPolicy: 'cursor-sandbox',
        }),
        mcpServers: [],
        toolNames: [],
        // buildTurn は lastMessageFile を使わないため scratchDir 自体は実質不使用だが、
        // CliTurnContext の型上は必須。claude/codex アダプタと同じ os.tmpdir() にしておく。
        scratchDir: os.tmpdir(),
      };
    },
  });
}
