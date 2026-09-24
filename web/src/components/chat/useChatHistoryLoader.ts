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
  /**
   * 死んだセッションの prune を ChatPanel.tsx 側へ委ねるコールバック。
   * 履歴 fetch effect の依存配列に入るため、呼び出し側は useCallback で
   * 安定させた参照を渡すこと — 毎描画で新しい関数を渡すと、この effect の
   * クリーンアップが毎回 historyRequestIdRef を進めてしまい、fetch 中の
   * リクエストを自分で捨てて取り直すループになる(E8/E13 の応答も巻き
   * 添えで無効化される)。
   */
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
  // 上の履歴 effect はこの用途に使えない。あちらは「メッセージが1件でもあれば
  // 何もしない」「一度読んだキーは二度と読まない」という二重のガードを持って
  // いて、送信済みスレッドには楽観表示した自分の発言が既に入っているため、
  // historyLoadedFor を落としても素通りしてしまう。ここは意図的に取り直す。
  //
  // 走るのは「送信したのに完了を見届けられなかった」と分かっているスレッドを
  // 表示したときだけなので、通常のスレッド切替に fetch は増えない。
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
        // 短くなる置き換えはしない。ターンがまだ走っている最中に戻ってくると、
        // サーバーの履歴にはまだ今回のやり取りが入っていないので、そのまま
        // 当てると楽観表示している自分の発言(と添付)が画面から消える。
        // 完了後の履歴は「利用者の発言 + 返信」の2件分増えているので、
        // 増えているときだけ当てれば取りこぼしだけを拾える。
        //
        // bdboard-3tw.158 (PR#135 レビュー minor-2 の対処): 保存件数が上限
        // (CHAT_MESSAGES_MAX_PER_SESSION) に達したセッションでは、サーバー側が
        // 古い方から捨てて件数を保つため取りこぼしたターンが載っても件数が
        // 伸びず、件数比較だけでは永久にこの安全網が効かない。そこで末尾
        // メッセージの createdAt 比較を併用する: send-chat-message.ts の
        // finalizeChatTurnSuccess はユーザー発言とAI応答をターン完了時に
        // まとめて1回で永続化するため、進行中のターンはサーバーに何も
        // 書かれておらず、サーバー末尾の createdAt は必ず「今回の送信より前」
        // のまま動かない。よって「サーバー末尾の createdAt が、ローカル末尾
        // の at (楽観送信時刻、常にクライアント側 Date.now())より新しい」は
        // 完了済みだけを正しく検知でき、進行中のケースを誤って壊さない。
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
        // モデルの復元はここでは行わない (PR#135 レビュー nit-3)。回収経路や
        // 履歴経路と非対称だが、この安全網が走るのは「このクライアント自身が
        // 送信したスレッド」だけで、送信成功時点で threadModelIds は既に
        // 書かれている。履歴側の「まだ値が無いキーにだけ書く」規律に従うと
        // 常に書かない側へ落ちるので、足しても観測できる差が無い。
        // 取り込めたときだけ印を外す。捨てた/短くて当てなかった場合は残して
        // おいて、次にこのスレッドを開いたときにもう一度試す。
        clearUnresolvedSend(sessionId);
      })
      .catch(() => {
        // 取り直しは付加的。失敗しても通常の表示は壊さない。
      })
      .finally(() => {
        unresolvedRefetchRef.current.delete(sessionId);
      });
    // 表示中の会話の件数を依存に入れておく (PR#135 レビュー minor-1)。印が
    // 立ったまま同じスレッドで次のターンが終わったとき、その場で取り直しへ
    // 戻れる。ストリーミングの delta は conversations ではなく別の state へ
    // 積まれるので、ここが配信ごとに揺れることはない。
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
