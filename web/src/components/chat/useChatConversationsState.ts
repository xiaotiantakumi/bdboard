import {
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type { ChatMessage } from './messages';

export interface ChatConversationEntry {
  messages: ChatMessage[];
  sessionId?: string;
  agentId?: string;
}

export interface UseChatConversationsStateResult {
  conversations: Record<string, ChatConversationEntry>;
  setConversations: Dispatch<SetStateAction<Record<string, ChatConversationEntry>>>;
  conversationsRef: MutableRefObject<Record<string, ChatConversationEntry>>;
  historyLoadedFor: Record<string, true>;
  setHistoryLoadedFor: Dispatch<SetStateAction<Record<string, true>>>;
  loadingHistoryFor: string | null;
  setLoadingHistoryFor: Dispatch<SetStateAction<string | null>>;
  threadModelIds: Record<string, string>;
  setThreadModelIds: Dispatch<SetStateAction<Record<string, string>>>;
  threadModelIdsRef: MutableRefObject<Record<string, string>>;
  historyRequestIdRef: MutableRefObject<number>;
  threadListRequestIdRef: MutableRefObject<number>;
}

/**
 * bdboard-sso1.83 第11段: ChatPanel.tsx から会話ストアの state
 * (conversations/historyLoadedFor/loadingHistoryFor/threadModelIds)と、
 * その ref ミラー(conversationsRef/threadModelIdsRef)、および履歴・スレッド
 * 一覧の request-id ガード(historyRequestIdRef/threadListRequestIdRef)を
 * move-only で抜き出したもの。effect は持たない(元々どれも useState/ref
 * ミラーの宣言だけで、effect はここには無かった)。request-id の ref は
 * E7(スレッド一覧 fetch)や E8(turn-status 回収)より前に存在している
 * 必要があるため、呼び出し位置は ChatPanel.tsx の上部(元の conversations
 * useState の位置)のまま。読み取り方式(ref で読む/render の値で読む)は
 * 一切変えていない。
 */
export function useChatConversationsState(): UseChatConversationsStateResult {
  const [conversations, setConversations] = useState<Record<string, ChatConversationEntry>>({});
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const [historyLoadedFor, setHistoryLoadedFor] = useState<Record<string, true>>({});
  const [loadingHistoryFor, setLoadingHistoryFor] = useState<string | null>(null);

  const [threadModelIds, setThreadModelIds] = useState<Record<string, string>>({});
  const threadModelIdsRef = useRef(threadModelIds);
  threadModelIdsRef.current = threadModelIds;

  const historyRequestIdRef = useRef(0);
  const threadListRequestIdRef = useRef(0);

  return {
    conversations,
    setConversations,
    conversationsRef,
    historyLoadedFor,
    setHistoryLoadedFor,
    loadingHistoryFor,
    setLoadingHistoryFor,
    threadModelIds,
    setThreadModelIds,
    threadModelIdsRef,
    historyRequestIdRef,
    threadListRequestIdRef,
  };
}
