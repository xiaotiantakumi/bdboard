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
  // 送信したのに、このクライアントでは完了を見届けられなかったスレッド
  // (返信を待たずに別スレッドへ移った等)。turn-status の回収が取りこぼした場合の
  // 安全網で、そのスレッドを表示したときに履歴を取り直す起点になる
  // (bdboard-3tw.156)。ref ではなく state なのは、まだ同じスレッドを表示している
  // うちに abort が確定した場合にも取り直しを走らせたいため。
  // unresolvedRefetchRef(取り直し二重取得の防止)は bdboard-sso1.83 第11段で
  // chat/useChatHistoryLoader.ts の内部へ移した。
  // bdboard-zlzo: done/error なしで配信が止まった送信。ターンはサーバー側で続いて
  // いるはずなので、その場ではエラーにせず turn-status 回収に任せる。サーバーは
  // recordCompletedTurn を済ませてからロックを解放するため、完走したターンは
  // processing → completed と見え、間に idle を挟まない。回収前に idle が見えたら
  // ターンは完走しなかった (エージェント失敗など、配信停止後はサーバーが error を
  // 送らない) ので、fail() で通常の送信失敗 (エラー表示と入力復元) に戻す。
  // streamingKey は配信停止時点の送信元の会話キー (streamingReply の Record を
  // 引くキー、bdboard-1qoe) を保持する
  // (bdboard-3tw.166)。回収が確定する (completed のハイドレーション or fail() 側の
  // 送信失敗表示) まで、この会話キーに対応する部分テキストを画面に残し続けるための
  // 目印で、確定した瞬間にだけ clearStreamingReplyForKey で消す。
  // bdboard-1qoe: 会話キーでスコープした Record にする (単一スロットだった頃は、
  // 無関係な会話/プロジェクトへの書き込み (送信開始時の初期化・完了時のクリア) が
  // 無条件にスロット全体を上書きし、別の会話がバックグラウンドで回収待ちの間
  // 表示し続けているはずの部分テキストを巻き添えで消してしまっていた。詳細は
  // 元チケット (bdboard-v3ag PR #492 の Opus レビュー worth-considering W2) 参照。
  const detachedStreamSendRef = useRef<Record<string, DetachedStreamSend>>({});
  // bdboard-t5i0 (bdboard-1qoe の残課題): streamingReply と対称的に、projectId を
  // キーにした Record にする。単一スロットの ref だった頃は、サーバー側の isBusy
  // ロックがプロジェクト単位である以上ごく普通に起きる「プロジェクト A の配信停止が
  // 回収待ちのまま、別プロジェクト B でも配信停止した」場合に、後から配信停止した B
  // への代入が A の { fail, streamingKey, ... } を無条件に上書きしていた。結果、A の
  // fail() コールバックが永久に失われ、A の checkTurnStatus (下の effect) がその後
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
  // 呼び出し側がある (submitChatMessage の完了/通常失敗クリア、~2888行目) —
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
