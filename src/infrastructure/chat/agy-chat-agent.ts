import os from 'node:os';
import type { ChatAgentPort, ChatTurnRequest } from '../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { buildBdSystemPrompt } from './bd-system-prompt.js';
import { createCliChatAgent } from './cli-chat-agent.js';
import { createAgySpec } from './specs/agy-spec.js';

const DEFAULT_AGY_PATH = 'agy';
const DEFAULT_BD_PATH = 'bd';
const DEFAULT_MODEL = '';
const DEFAULT_TIMEOUT_MS = 180_000;

export interface AgyChatAgentOptions {
  readonly agyPath?: string;
  readonly bdPath?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * cursor-chat-agent.ts と同型(bdboard-l1t.6)。bd MCP サーバーは一切配線しない
 * (mcpServers: [] / toolNames: [])。agy CLI にはターン単位で MCP サーバーを注入する
 * 手段が無く、ワークスペースの plugins/hooks も読み込まないため(実測の詳細は
 * specs/agy-spec.ts のコメントを参照)、bd ツールを渡すことが構造的にできない。
 * buildBdSystemPrompt には hasBdTools: false と shellToolPolicy:
 * 'agy-headless-allowlist' を渡し、「bd ツールは無い、bd 操作は運用者が許可ルールを
 * 設定済みの場合のみシェルの bd コマンドで行え」という agy 固有の実態を正直に伝える。
 *
 * capability は codex/cursor と同じ 'unrestricted'(実際に到達できるツール面は運用者側の
 * permissions 設定に依存するため、最悪ケースでの正直な申告。specs/agy-spec.ts の
 * descriptor コメントを参照)。この権限の広さ自体の是非は bdboard-9a9 の裁定で決着済み。
 */
export function createAgyChatAgent(commandRunner: CommandRunner, options?: AgyChatAgentOptions): ChatAgentPort {
  const agyPath = options?.agyPath ?? process.env.BDBOARD_AGY_PATH ?? DEFAULT_AGY_PATH;
  // bd MCP を配線しないため bdPath は MCP サーバー起動には使わず、システムプロンプトが
  // 案内する「シェルで直接呼ぶ bd コマンド」の実体として使う(cursor の MF2 と同じ経路)。
  // agyPath と対称に、options 未指定でも環境変数から直接引けるようにする(Opus
  // レビュー N1。registry builder を通さない直接生成でも設定が反映されるように)。
  const bdPath = options?.bdPath ?? process.env.BDBOARD_BD_PATH ?? DEFAULT_BD_PATH;
  const model = options?.model ?? DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spec = createAgySpec({ agyPath, model, timeoutMs });
  return createCliChatAgent(commandRunner, spec, {
    env: options?.env ?? process.env,
    buildContext(request: ChatTurnRequest) {
      return {
        systemPrompt: buildBdSystemPrompt({ projectName: request.projectName, projectRootPath: request.projectRootPath, capability: 'unrestricted', hasBdTools: false, bdPath, shellToolPolicy: 'agy-headless-allowlist' }),
        mcpServers: [],
        toolNames: [],
        // buildTurn は lastMessageFile を使わないため scratchDir 自体は実質不使用だが、
        // CliTurnContext の型上は必須。他アダプタと同じ os.tmpdir() にしておく。
        scratchDir: os.tmpdir(),
      };
    },
  });
}
