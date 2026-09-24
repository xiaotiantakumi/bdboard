import {
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { ApiError, fetchChatSessionMessages } from '../../api';
import { writePersistedChatThread } from '../../chatThreadStorage';
import { toChatMessages } from './messages';
import type { ChatConversationEntry } from './useChatConversationsState';

/**
 * bdboard-sso1.83 第11段: ChatPanel.tsx から履歴 fetch effect(旧 E12)と、
 * turn-status 回収の取りこぼしを拾う安全網 effect(旧 E13、bdboard-3tw.156)を、
 * 元の登録順のまま1つの effect フックへ move-only で抜き出したもの
 * (E12→E13 の順は維持。どちらも historyRequestIdRef を通じて E8 より後に
 * 実行される前提)。呼び出し位置は元の E12 の位置のまま。
 *
 * 死んだセッション(404、または「不明なセッション」を意味する 400)を
 * 検出したときの openThreadIds/threadLists/selectedThreadIds の prune と、
 * 選択が外れた場合の永続化・ドラフト nonce の前進(bdboard-pbf/bdboard-23u)は、
 * 会話キー再割り当て(bdboard-c1pw 領域)を所有する ChatPanel.tsx 側に残し、
 * onSessionGone コールバック経由で呼ぶ(第11段では移さない)。
 */
export function useChatHistoryLoader(params: {
  selectedProjectId: string;
  currentConversationKey: string;
  currentSessionId: string | undefined;
  conversations: Record<string, ChatConversationEntry>;
  historyLoadedFor: Record<string, true>;
  setConversations: Dispatch<SetStateAction<Record<string, ChatConversationEntry>>>;
  setHistoryLoadedFor: Dispatch<SetStateAction<Record<string, true>>>;
  setLoadingHistoryFor: Dispatch<SetStateAction<string | null>>;
  setThreadModelIds: Dispatch<SetStateAction<Record<string, string>>>;
  historyRequestIdRef: MutableRefObject<number>;
  conversationsRef: MutableRefObject<Record<string, ChatConversationEntry>>;
  setSelectedAgentId: Dispatch<SetStateAction<string>>;
  unresolvedSends: Record<string, true>;
  clearUnresolvedSend: (sessionId: string) => void;
  onSessionGone: (sessionId: string) => void;
}): void {
  const {
    selectedProjectId,
    currentConversationKey,
    currentSessionId,
    conversations,
    historyLoadedFor,
    setConversations,
    setHistoryLoadedFor,
    setLoadingHistoryFor,
    setThreadModelIds,
    historyRequestIdRef,
    conversationsRef,
    setSelectedAgentId,
    unresolvedSends,
    clearUnresolvedSend,
    onSessionGone,
  } = params;

  // 二重取得の抑止は ref で持つ(旧 E13 の unresolvedRefetchRef)。印を先に
  // state から外すと、その更新でこの effect 自身が張り直され、走り出した
  // fetch を自分で捨ててしまう。
  const unresolvedRefetchRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (selectedProjectId === '') {
      return;
    }

    const conversation = conversations[currentConversationKey];
    if ((conversation?.messages.length ?? 0) > 0) {
      return;
    }
    if (historyLoadedFor[currentConversationKey] === true) {
      return;
    }

    const sessionId = conversation?.sessionId ?? currentSessionId;
    if (sessionId === undefined) {
      setHistoryLoadedFor((prev) => ({ ...prev, [currentConversationKey]: true }));
      return;
    }

    const requestId = historyRequestIdRef.current;
    setLoadingHistoryFor(currentConversationKey);

    void fetchChatSessionMessages(sessionId, selectedProjectId)
      .then((payload) => {
        if (requestId !== historyRequestIdRef.current) {
          return;
        }
        setConversations((prev) => ({
          ...prev,
          [currentConversationKey]: {
            messages: toChatMessages(payload.messages),
            sessionId: payload.sessionId,
            agentId: payload.agentId,
          },
        }));
        writePersistedChatThread(selectedProjectId, {
          sessionId: payload.sessionId,
          agentId: payload.agentId,
        });
        // bdboard-2n8: 「このレスポンスが今表示中の会話
        // (currentConversationKey)に対応する最新のリクエストである」ことは
        // 直前の `requestId !== historyRequestIdRef.current` ガードで既に
        // 保証されている。ユーザーによる手動エージェント変更は必ず
        // currentConversationKey も変えるため、追加のスナップショット比較は
        // 不要(104.9 と同じ「現在の state との整合チェックだけに頼る」
        // パターン)。
        if (payload.agentId !== '') {
          setSelectedAgentId(payload.agentId);
        }
        if (payload.model !== undefined && payload.model !== '') {
          const restoredModel = payload.model;
          // bdboard-2n8: 手動モデル選択(threadModelIds[currentConversationKey]
          // に書き込み済み)を、サーバー復元値で上書きしない。「まだ値が無い
          // キーにだけ書く」。
          setThreadModelIds((prev) =>
            prev[payload.sessionId] !== undefined
              ? prev
              : { ...prev, [payload.sessionId]: restoredModel },
          );
        }
      })
      .catch((error: unknown) => {
        if (requestId !== historyRequestIdRef.current) {
          return;
        }
        // bdboard-pbf / bdboard-23u: 死んだセッションの prune・永続化・
        // ドラフト nonce の前進は ChatPanel.tsx 側
        // (handleHistorySessionGone)に委ねる。
        if (
          error instanceof ApiError &&
          (error.status === 404 ||
            (error.status === 400 && error.errorMessage === 'unknown chat session'))
        ) {
          onSessionGone(sessionId);
        }
      })
      .finally(() => {
        if (requestId !== historyRequestIdRef.current) {
          return;
        }
        setLoadingHistoryFor(null);
        setHistoryLoadedFor((prev) => ({
          ...prev,
          [currentConversationKey]: true,
        }));
      });

    return () => {
      historyRequestIdRef.current += 1;
      setLoadingHistoryFor(null);
    };
  }, [
    selectedProjectId,
    currentConversationKey,
    currentSessionId,
    conversations,
    historyLoadedFor,
    setConversations,
    setHistoryLoadedFor,
    setLoadingHistoryFor,
    setThreadModelIds,
    setSelectedAgentId,
    onSessionGone,
  ]);

  // turn-status の回収が完了を取りこぼしたときの安全網(bdboard-3tw.156)。
  // 上の履歴 effect はこの用途に使えない(送信済みスレッドは
  // historyLoadedFor が既に立っており素通りする)ため、意図的に取り直す。
  // 走るのは「送信したのに完了を見届けられなかった」スレッドを表示した
  // ときだけで、通常のスレッド切替に fetch は増えない。
  useEffect(() => {
    if (selectedProjectId === '') return;
    const sessionId = currentSessionId;
    if (sessionId === undefined || unresolvedSends[sessionId] !== true) return;
    if (unresolvedRefetchRef.current.has(sessionId)) return;
    unresolvedRefetchRef.current.add(sessionId);

    const requestId = historyRequestIdRef.current;
    void fetchChatSessionMessages(sessionId, selectedProjectId)
      .then((payload) => {
        if (requestId !== historyRequestIdRef.current) return;
        // 短くなる置き換えはしない(進行中のターンはまだサーバーに反映
        // されていないことがあるため)。件数が増えているか、末尾の
        // createdAt がローカルの楽観送信時刻より新しいときだけ当てる
        // (bdboard-3tw.158、CHAT_MESSAGES_MAX_PER_SESSION での eviction 対策)。
        const localMessages = conversationsRef.current[sessionId]?.messages ?? [];
        const localCount = localMessages.length;
        const grew = payload.messages.length > localCount;
        const lastLocal = localMessages[localMessages.length - 1];
        const lastServer = payload.messages[payload.messages.length - 1];
        const serverTailIsNewer =
          lastLocal !== undefined &&
          lastServer !== undefined &&
          Date.parse(lastServer.createdAt) > lastLocal.at;
        if (!grew && !serverTailIsNewer) return;
        setConversations((prev) => ({
          ...prev,
          [sessionId]: {
            messages: toChatMessages(payload.messages),
            sessionId: payload.sessionId,
            agentId: payload.agentId,
          },
        }));
        setHistoryLoadedFor((prev) => ({ ...prev, [sessionId]: true }));
        // モデルの復元はここでは行わない(PR#135 レビュー nit-3)。この
        // 安全網は自分自身が送信したスレッドにしか走らず、送信成功時点で
        // threadModelIds は既に書かれている。
        clearUnresolvedSend(sessionId);
      })
      .catch(() => {
        // 取り直しは付加的。失敗しても通常の表示は壊さない。
      })
      .finally(() => {
        unresolvedRefetchRef.current.delete(sessionId);
      });
  }, [
    selectedProjectId,
    currentSessionId,
    unresolvedSends,
    clearUnresolvedSend,
    setConversations,
    setHistoryLoadedFor,
    currentSessionId === undefined
      ? 0
      : (conversations[currentSessionId]?.messages.length ?? 0),
  ]);
}
