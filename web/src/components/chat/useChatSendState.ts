import { useCallback, useReducer, useRef, type MutableRefObject } from 'react';
import {
  chatSendReducer,
  initialChatSendState,
  type ChatSendState,
} from './chatSendState';

export interface DetachedStreamSend {
  // undefined は新規ドラフトの初回送信で sessionId が未確定の間にありうる。
  sessionId: string | undefined;
  streamingKey: string;
  // bdboard-96rp: 発生時刻 (Date.now()) を憶えておく。sessionId が未確定 (新規
  // スレッドの初回送信) な間は、後段の checkTurnStatus がこの送信「自身」の
  // 失敗と「無関係な古い sessionId 無しエントリ」を sessionId だけでは区別
  // できない — この時刻より前に記録された sessionId 無しエントリは、この
  // 送信より前に失敗した別の送信のものだと判定できる (詳細は checkTurnStatus
  // の 'failed' 分岐)。
  detachedAt: number;
  fail: () => void;
}

type Updater<T> = (previous: T) => T;

export interface UseChatSendStateResult extends ChatSendState {
  setIsSending: (value: boolean) => void;
  setStreamingReply: (updater: Updater<Record<string, string>>) => void;
  setTurnRecoveryGeneration: (updater: Updater<number>) => void;
  clearStreamingReplyForKey: (key: string) => void;
  markUnresolvedSend: (sessionId: string | undefined) => void;
  clearUnresolvedSend: (sessionId: string) => void;
  detachedStreamSendRef: MutableRefObject<Record<string, DetachedStreamSend>>;
  requestAbortControllerRef: MutableRefObject<AbortController | null>;
}

/**
 * bdboard-sso1.83 第13a段: ChatPanel.tsx の送信状態配線を抜き出す薄いフック。
 * setter は旧 setState と同じ形で安定しており、送信本体の呼び出しを保つ。
 */
export function useChatSendState(): UseChatSendStateResult {
  const [state, dispatch] = useReducer(chatSendReducer, initialChatSendState);
  // streamingReply(bdboard-1qoe)と unresolvedSends(bdboard-3tw.156/bdboard-zlzo)の
  // 由来コメントは chatSendState.ts 側(initialChatSendState/unresolvedSendsSlice の
  // 近く)にある。ここに残すのは detachedStreamSendRef/requestAbortControllerRef の
  // 2つの ref だけ。
  const detachedStreamSendRef = useRef<Record<string, DetachedStreamSend>>({});
  // bdboard-t5i0 (bdboard-1qoe の残課題): streamingReply と対称的に、projectId を
  // キーにした Record にする。単一スロットの ref だった頃は、サーバー側の isBusy
  // ロックがプロジェクト単位である以上ごく普通に起きる「プロジェクト A の配信停止が
  // 回収待ちのまま、別プロジェクト B でも配信停止した」場合に、後から配信停止した B
  // への代入が A の { fail, streamingKey, ... } を無条件に上書きしていた。結果、A の
  // fail() コールバックが永久に失われ、A の checkTurnStatus (chat/useTurnStatusRecovery.ts) がその後
  // 'failed'/'idle' を見ても、ref はもう B の情報しか持っていないため A 用の fail()
  // を呼べず、A 側の画面は「回収中」のまま二度と解決しない凍りついた表示になっていた
  // (実害の詳細はチケット本文・コメント参照)。projectId ごとに独立したエントリへ
  // 分離することで、この上書き自体が構造的に起きなくなる — B の代入は A のキーに
  // 触れない。
  const requestAbortControllerRef = useRef<AbortController | null>(null);

  const setIsSending = useCallback((value: boolean) => dispatch({ type: 'set-is-sending', value }), []);
  const setStreamingReply = useCallback(
    (updater: Updater<Record<string, string>>) => dispatch({ type: 'replace-streaming-reply', updater }),
    [],
  );
  const setTurnRecoveryGeneration = useCallback(
    (updater: Updater<number>) => dispatch({ type: 'replace-turn-recovery-generation', updater }),
    [],
  );
  // bdboard-3tw.166: 配信停止からの回収中に表示し続けている部分テキストを、
  // その会話キーのものだけ消す。streamingReply は会話キーでスコープした Record
  // (bdboard-1qoe) なので、これはその1キーだけを delete する形になる。
  // bdboard-1qoe 以降、この「その会話キーだけ消す」性質に実際に依存している
  // 呼び出し側がある (chat/deliverChatSend.ts の完了/通常失敗クリア) —
  // 無関係な会話/プロジェクトの部分テキストを巻き添えで消さないための本番経路。
  const clearStreamingReplyForKey = useCallback(
    (key: string) => dispatch({ type: 'clear-streaming-reply-for-key', key }),
    [],
  );
  // markUnresolvedSend(undefined) は、新規ドラフトの送信で sessionId がまだ無い
  // 場合に安全に何もしない。
  const markUnresolvedSend = useCallback((sessionId: string | undefined) => {
    if (sessionId === undefined) return;
    dispatch({ type: 'mark-unresolved-send', sessionId });
  }, []);
  // clearUnresolvedSend はキーが存在する場合だけ Record を複製する。存在しない
  // キーを消すときは旧 useState setter と同様、元の参照を維持する。
  const clearUnresolvedSend = useCallback(
    (sessionId: string) => dispatch({ type: 'clear-unresolved-send', sessionId }),
    [],
  );

  return {
    ...state,
    setIsSending,
    setStreamingReply,
    setTurnRecoveryGeneration,
    clearStreamingReplyForKey,
    markUnresolvedSend,
    clearUnresolvedSend,
    detachedStreamSendRef,
    requestAbortControllerRef,
  };
}
