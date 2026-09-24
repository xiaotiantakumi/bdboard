import {
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { makeDraftKey } from './draftKey';

export interface UseConversationKeyResult {
  selectedThreadIds: Record<string, string | undefined>;
  setSelectedThreadIds: Dispatch<SetStateAction<Record<string, string | undefined>>>;
  selectedThreadIdsRef: MutableRefObject<Record<string, string | undefined>>;
  draftNonces: Record<string, number>;
  setDraftNonces: Dispatch<SetStateAction<Record<string, number>>>;
  draftNoncesRef: MutableRefObject<Record<string, number>>;
  currentSessionId: string | undefined;
  currentConversationKey: string;
  currentConversationKeyRef: MutableRefObject<string>;
}

/**
 * bdboard-sso1.83 第10段: ChatPanel.tsx から会話キーの導出(selectedThreadIds/
 * draftNonces と、そこから計算する currentSessionId/currentConversationKey、
 * および各種 stale-closure 回避用の ref ミラー)を move-only で抜き出したもの。
 * effect は持たない(元々どれも useState/派生値の計算だけで、effect はここには
 * 無かった)。読み取り方式(prev で読む/ref で読む/render の値で読む)は一切
 * 変えていない。
 */
export function useConversationKey(selectedProjectId: string): UseConversationKeyResult {
  const [selectedThreadIds, setSelectedThreadIds] = useState<Record<string, string | undefined>>(
    {},
  );
  const [draftNonces, setDraftNonces] = useState<Record<string, number>>({});
  const currentSessionId = selectedThreadIds[selectedProjectId];
  const draftKey = (projectId: string) => makeDraftKey(projectId, draftNonces[projectId] ?? 0);
  const currentConversationKey = currentSessionId ?? draftKey(selectedProjectId);
  const currentConversationKeyRef = useRef(currentConversationKey);
  currentConversationKeyRef.current = currentConversationKey;

  const draftNoncesRef = useRef(draftNonces);
  draftNoncesRef.current = draftNonces;

  // bdboard-ysu: 下の project-sync effect(ChatPanel 側に残る)が、非同期に解決する
  // fetchChatThreads().then/.catch の中から「今まさにどのスレッドが選択
  // されているか」を stale closure を経由せず読むための参照。draftNoncesRef /
  // conversationInputsRef と同じミラーパターン。
  const selectedThreadIdsRef = useRef(selectedThreadIds);
  selectedThreadIdsRef.current = selectedThreadIds;

  return {
    selectedThreadIds,
    setSelectedThreadIds,
    selectedThreadIdsRef,
    draftNonces,
    setDraftNonces,
    draftNoncesRef,
    currentSessionId,
    currentConversationKey,
    currentConversationKeyRef,
  };
}
