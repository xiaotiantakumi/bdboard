import { isValidChatSessionId } from '../../domain/chat.js';
import type { BoardCache } from '../ports/board-cache.js';
import type {
  ChatSessionDiscoveryPort,
  DiscoveredChatSession,
} from '../ports/chat-session-discovery.js';
import type { TranscriptTailMessage } from '../transcript/parse-transcript-messages.js';
import type { ChatAgentRegistry } from './chat-agent-registry.js';
import type { ChatSessionStore } from './chat-session-store.js';

/**
 * adopt が既定で紐付ける chat エージェントの id (bdboard-3tw.104.3 レビュー S2)。
 *
 * discovery が発見するのは claude CLI が書いたトランスクリプトだけ(chat-session-discovery.ts
 * は `~/.claude/projects/**` を読む)なので、adopt 対象は常に claude CLI セッションである。
 * それにもかかわらず旧実装は `agents.defaultAgent()`(登録順ではなく id のアルファベット順で
 * 先頭の非experimentalエージェント)を使っていた — たまたま 'claude' が先頭に来る registry
 * 構成でしか正しく動かない、事故りやすい暗黙依存だった。ここでは discovery の対象と一致する
 * agent id を明示し、居なければ(claude CLI アダプタが未登録の環境)loud に失敗する。
 *
 * bdboard-81b: cursor-agent のセッション(~/.cursor/chats)を discovery 対象に追加するかを
 * 調査した結果、見送っている。調査記録と理由は bdboard-81b の bd comment を参照。
 */
const CLAUDE_CLI_CHAT_AGENT_ID = 'claude';

export interface DiscoveredChatSessionWithStatus extends DiscoveredChatSession {
  readonly alreadyAdopted: boolean;
}

export type ListDiscoveredChatSessionsResult =
  | { readonly ok: true; readonly sessions: readonly DiscoveredChatSessionWithStatus[] }
  | { readonly ok: false; readonly failure: { readonly kind: 'project-not-found' } };

export async function listDiscoveredChatSessions(
  deps: {
    readonly cache: BoardCache;
    readonly discovery: ChatSessionDiscoveryPort;
    readonly store: ChatSessionStore;
  },
  projectId: string,
): Promise<ListDiscoveredChatSessionsResult> {
  const cached = deps.cache.getProject(projectId);
  if (cached === undefined) {
    return { ok: false, failure: { kind: 'project-not-found' } };
  }

  const allProjects = deps.cache.listProjects().map((entry) => entry.project);
  const discovered = await deps.discovery.listDiscoveredSessions(cached.project, allProjects);
  return {
    ok: true,
    sessions: discovered.map((session) => ({
      ...session,
      alreadyAdopted: deps.store.lookup(projectId, session.sessionId) !== undefined,
    })),
  };
}

export type AdoptChatSessionFailure =
  | { readonly kind: 'project-not-found' }
  | { readonly kind: 'invalid-session-id' }
  | { readonly kind: 'unknown-agent'; readonly detail: string }
  | { readonly kind: 'unknown-session' };

export type AdoptChatSessionResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly agentId: string;
      /** adopt 直後にチャット履歴をシードするための、トランスクリプト末尾の会話 (M1)。 */
      readonly seedMessages: readonly TranscriptTailMessage[];
    }
  | { readonly ok: false; readonly failure: AdoptChatSessionFailure };

export async function adoptChatSession(
  deps: {
    readonly cache: BoardCache;
    readonly discovery: ChatSessionDiscoveryPort;
    readonly store: ChatSessionStore;
    readonly agents: ChatAgentRegistry;
  },
  input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly agentId?: string;
  },
): Promise<AdoptChatSessionResult> {
  const cached = deps.cache.getProject(input.projectId);
  if (cached === undefined) {
    return { ok: false, failure: { kind: 'project-not-found' } };
  }

  if (
    !isValidChatSessionId(input.sessionId) ||
    input.sessionId.includes('/') ||
    input.sessionId.includes('\\') ||
    input.sessionId.includes('..')
  ) {
    return { ok: false, failure: { kind: 'invalid-session-id' } };
  }

  // bdboard-l1t.5 Opus レビュー SF6(b): discovery が読むのは claude CLI の
  // トランスクリプト(~/.claude/projects/**)だけであり、codex/cursor 等の他エージェントの
  // セッションを発見する経路がそもそも無い。にもかかわらず旧実装は input.agentId に
  // 登録済みの任意の agent id(例: 'cursor')を渡せてしまい、実体は claude CLI の
  // トランスクリプトなのに別エージェントの所有として adopt されてしまう不整合を
  // 許していた。ここで discovery の対象と一致する 'claude' 以外を明示的に拒否する。
  if (input.agentId !== undefined && input.agentId !== CLAUDE_CLI_CHAT_AGENT_ID) {
    return {
      ok: false,
      failure: {
        kind: 'unknown-agent',
        detail: 'chat session discovery only supports the claude CLI agent',
      },
    };
  }

  if (deps.agents.get(CLAUDE_CLI_CHAT_AGENT_ID) === undefined) {
    return {
      ok: false,
      failure: { kind: 'unknown-agent', detail: 'claude chat agent is not registered' },
    };
  }
  const agentId = CLAUDE_CLI_CHAT_AGENT_ID;

  const allProjects = deps.cache.listProjects().map((entry) => entry.project);
  if (!(await deps.discovery.verifySessionExists(cached.project, allProjects, input.sessionId))) {
    return { ok: false, failure: { kind: 'unknown-session' } };
  }

  const seedMessages =
    (await deps.discovery.readAdoptSeedMessages(cached.project, allProjects, input.sessionId)) ?? [];

  deps.store.remember(input.projectId, input.sessionId, agentId);
  return { ok: true, sessionId: input.sessionId, agentId, seedMessages };
}
