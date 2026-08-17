import { CHAT_MESSAGE_MAX_LENGTH, CHAT_FAILED_TOOLS_MAX } from '../../domain/chat.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';
import type { ChatMessageRepository } from '../ports/chat-message-repository.js';
import {
  ChatAgentError,
  type ChatAgentPort,
  type ChatFailureCode,
  type ChatTurnRequest,
  type ChatTurnResult,
} from '../ports/chat-agent.js';
import type { ChatAgentRegistry } from './chat-agent-registry.js';
import type { ChatSessionStore } from './chat-session-store.js';

export type SendChatMessageFailure =
  | { readonly kind: 'project-not-found' }
  | { readonly kind: 'invalid-message'; readonly detail: string }
  | { readonly kind: 'unknown-session' }
  | { readonly kind: 'unknown-agent'; readonly detail: string }
  | { readonly kind: 'unknown-model'; readonly detail: string }
  | { readonly kind: 'agent-mismatch'; readonly detail: string }
  | { readonly kind: 'agent-unavailable'; readonly detail: string }
  | { readonly kind: 'busy' }
  | { readonly kind: 'streaming-not-supported' }
  | { readonly kind: 'agent-error'; readonly code: ChatFailureCode; readonly detail: string };

export type SendChatMessageResult =
  | {
      readonly ok: true;
      readonly reply: string;
      readonly sessionId: string;
      readonly agentId: string;
      readonly model?: string;
      /**
       * 今回のターンで実行できなかった bd ツール呼び出しの名前(承認拒否・エラー
       * 両方を含む。厳密な「拒否」だけではないので denied ではなく failed と
       * 呼ぶ)。1件も無ければ省略する(bdboard-l1t.4 MF3)。
       */
      readonly failedTools?: readonly string[];
    }
  | { readonly ok: false; readonly failure: SendChatMessageFailure };

export interface SendChatMessageDeps {
  readonly cache: BoardCache;
  readonly agents: ChatAgentRegistry;
  readonly store: ChatSessionStore;
  readonly messages: ChatMessageRepository;
}

export interface SendChatMessageInput {
  readonly projectId: string;
  readonly message: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly model?: string;
}

export interface ResolvedChatTurnAgent {
  readonly ok: true;
  readonly agent: ChatAgentPort;
  readonly trimmedMessage: string;
  readonly cachedProject: CachedProject;
  readonly resolvedAgentId: string;
  readonly release: () => void;
}

export type ResolveChatTurnAgentResult =
  | ResolvedChatTurnAgent
  | { readonly ok: false; readonly failure: SendChatMessageFailure };

export async function resolveChatTurnAgent(
  deps: SendChatMessageDeps,
  input: SendChatMessageInput,
): Promise<ResolveChatTurnAgentResult> {
  const cachedProject = deps.cache.getProject(input.projectId);
  if (cachedProject === undefined) return { ok: false, failure: { kind: 'project-not-found' } };
  const trimmedMessage = input.message.trim();
  if (trimmedMessage.length === 0) return { ok: false, failure: { kind: 'invalid-message', detail: 'message is empty' } };
  if (trimmedMessage.length > CHAT_MESSAGE_MAX_LENGTH) return { ok: false, failure: { kind: 'invalid-message', detail: 'message is too long' } };

  let resolvedAgentId: string | undefined;
  if (input.sessionId !== undefined) {
    const record = deps.store.lookup(input.projectId, input.sessionId);
    if (record === undefined) return { ok: false, failure: { kind: 'unknown-session' } };
    if (input.agentId !== undefined && input.agentId !== record.agentId) {
      return { ok: false, failure: { kind: 'agent-mismatch', detail: `session belongs to agent ${record.agentId}` } };
    }
    resolvedAgentId = record.agentId;
  } else {
    resolvedAgentId = input.agentId ?? deps.agents.defaultAgent()?.descriptor.id;
    if (resolvedAgentId === undefined) return { ok: false, failure: { kind: 'unknown-agent', detail: 'no chat agent is registered' } };
  }

  const agent = deps.agents.get(resolvedAgentId);
  if (agent === undefined) return { ok: false, failure: { kind: 'unknown-agent', detail: 'unknown chat agent' } };
  if (input.model !== undefined && !(agent.descriptor.models ?? []).some((entry) => entry.id === input.model)) {
    return { ok: false, failure: { kind: 'unknown-model', detail: 'unknown chat model' } };
  }
  if (!deps.store.tryAcquire(input.projectId)) return { ok: false, failure: { kind: 'busy' } };
  return { ok: true, agent, trimmedMessage, cachedProject, resolvedAgentId, release: () => deps.store.release(input.projectId) };
}

export function createChatTurnRequest(
  resolved: Pick<ResolvedChatTurnAgent, 'cachedProject' | 'trimmedMessage'>,
  input: Pick<SendChatMessageInput, 'sessionId' | 'model'>,
): ChatTurnRequest {
  return {
    projectRootPath: resolved.cachedProject.project.rootPath,
    projectName: resolved.cachedProject.project.name,
    message: resolved.trimmedMessage,
    ...(input.sessionId !== undefined ? { resumeSessionId: input.sessionId } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
}

export function finalizeChatTurnSuccess(
  deps: SendChatMessageDeps,
  input: SendChatMessageInput,
  turnResult: ChatTurnResult,
): Extract<SendChatMessageResult, { readonly ok: true }> {
  deps.store.remember(input.projectId, turnResult.sessionId, turnResult.agentId);
  // input.model はUIのセレクタID(例: 'opus')、turnResult.model はCLIが返す実際の
  // 課金対象モデルID(例: 'claude-sonnet-5')で、別の名前空間。復元時に
  // ChatAgentDto.models[].id と突き合わせるのはセレクタIDなので、優先すべきは
  // input.model — CLIの生値を保存すると復元照合が常に失敗し、再読み込み後に
  // 常定モデルへ静かにフォールバックしてしまう。
  const resolvedModel = input.model ?? turnResult.model;
  if (resolvedModel !== undefined) deps.store.updateModel(input.projectId, turnResult.sessionId, resolvedModel);
  // 重複除去 + 上限 (CHAT_FAILED_TOOLS_MAX): denial はツール呼び出し1回ごとに
  // 1エントリ生まれるため、そのまま永続化すると同名の羅列で無制限に膨らむ
  // (bdboard-l1t.4 MF3)。
  const failedTools = [...new Set(turnResult.failedTools)].slice(0, CHAT_FAILED_TOOLS_MAX);
  try {
    deps.messages.append(turnResult.sessionId, [
      { role: 'user', content: input.message.trim() },
      { role: 'assistant', content: turnResult.reply, ...(failedTools.length > 0 ? { failedTools } : {}) },
    ]);
  } catch {
    // History persistence is best-effort.
  }
  return {
    ok: true,
    reply: turnResult.reply,
    sessionId: turnResult.sessionId,
    agentId: turnResult.agentId,
    ...(turnResult.model !== undefined ? { model: turnResult.model } : {}),
    ...(failedTools.length > 0 ? { failedTools } : {}),
  };
}

export function mapChatAgentErrorToFailure(err: ChatAgentError): SendChatMessageFailure {
  // CLI が起動できないのは「今このエージェントは使えない」であって
  // 上流のエラーではないので 503 側に寄せる (bdboard-l1t.2 + bdboard-pvl)。
  return err.code === 'agent-not-found'
    ? { kind: 'agent-unavailable', detail: err.detail }
    : { kind: 'agent-error', code: err.code, detail: err.detail };
}

export async function sendChatMessage(
  deps: SendChatMessageDeps,
  input: SendChatMessageInput,
): Promise<SendChatMessageResult> {
  const resolved = await resolveChatTurnAgent(deps, input);
  if (!resolved.ok) return resolved;
  try {
    const turnResult = await resolved.agent.sendMessage(createChatTurnRequest(resolved, input));
    return finalizeChatTurnSuccess(deps, input, turnResult);
  } catch (err) {
    if (err instanceof ChatAgentError) return { ok: false, failure: mapChatAgentErrorToFailure(err) };
    throw err;
  } finally {
    resolved.release();
  }
}
