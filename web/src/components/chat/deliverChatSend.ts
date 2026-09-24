import {
  acknowledgeChatTurn,
  postChatMessage,
  postChatMessageStream,
  ChatStreamEndedWithoutResultError,
  type ChatMessageRequest,
  type ChatMessageResponseDto,
} from '../../api';
import { CHAT_STREAM_DETACHED_FAILED_MESSAGE } from './turnStatusPolicy';
import type { UseChatSendStateResult } from './useChatSendState';

export interface DeliverChatSendParams {
  payload: ChatMessageRequest;
  streaming: boolean;
  signal: AbortSignal;
  projectId: string;
  // 送信時点の会話キー。await の前に呼び出し側(useChatSubmit)で確定させた値。
  sendKey: string;
  sessionId: string | undefined;
  // 成功: commitSuccess(sendKey, text, result)。失敗: commitFailure(sendKey, sentRawText, …)。
  // どちらも呼び出し側が送信時点の値を閉じ込めて渡す。
  onSuccess: (result: ChatMessageResponseDto) => void;
  onFailure: (error: unknown) => void;
  send: Pick<
    UseChatSendStateResult,
    | 'setStreamingReply'
    | 'setTurnRecoveryGeneration'
    | 'markUnresolvedSend'
    | 'clearStreamingReplyForKey'
    | 'detachedStreamSendRef'
  >;
}

/**
 * bdboard-sso1.83 第13b段: 送信本体(chat/useChatSubmit.ts の submit)の try の中身
 * (POST/ストリームと、その結果の振り分け)を抜き出したもの。分岐・順番・コメントは
 * 元の submitChatMessage(ChatPanel.tsx)のまま。React には依存しない。
 * AbortError / 配信停止 / 通常失敗はここで吸収し、それ以外(アダプタの想定外の
 * 失敗)だけが呼び出し側へ throw される。isSending・focus・controller の後始末は
 * 呼び出し側の finally が持つ。関数境界が1つ増えたぶん、呼び出し側の finally
 * (setIsSending(false)/focus)は元より数 microtask 後に走る(ブラウザの paint の機会は増えない)。
 */
export async function deliverChatSend(params: DeliverChatSendParams): Promise<void> {
  const { payload, streaming, signal, projectId, sendKey, sessionId, onSuccess, onFailure } = params;
  const {
    setStreamingReply,
    setTurnRecoveryGeneration,
    markUnresolvedSend,
    clearStreamingReplyForKey,
    detachedStreamSendRef,
  } = params.send;
  // bdboard-zlzo: 新しいターンが完走したならサーバーは空いていたので、前の配信停止分の
  // 判定は捨てる (失われるのは失敗表示だけ)。送信の開始時点では捨てない —
  // 前のターンが続いている間の再送は 409 で弾かれ、判定を失うと、その後に前の
  // ターンが失敗しても何も表示されなくなる。
  const settleEarlierDetachedSend = (): void => {
    const detached = detachedStreamSendRef.current[projectId];
    if (detached !== undefined) {
      delete detachedStreamSendRef.current[projectId];
      // bdboard-3tw.166: 前の配信停止分が残していた部分テキストも一緒に消す。
      // 新しいターンが完走した以上、その古い部分テキストが後から置き換わる
      // ことはもう無い (このあと fail() も呼ばれない)。
      clearStreamingReplyForKey(detached.streamingKey);
    }
  };

  if (streaming) {
    // bdboard-1qoe: 会話キーだけを初期化する (Record 全体を作り直さない)。
    // 無関係な会話/プロジェクトが同じ Record に保持している部分テキストを
    // 巻き添えで消さないため。
    setStreamingReply((prev) => ({ ...prev, [sendKey]: '' }));
    // bdboard-3tw.166 (Opus レビュー指摘): 「この送信が今まさに配信停止した」を
    // detachedStreamSendRef.current の中身 (streamingKey が sendKey と一致するか)
    // で判定すると、同じ会話キーへの以前の (まだ未解決の) 配信停止が残っている
    // ときに誤判定する — 例えば前のターンが配信停止で回収待ちのまま、同じ会話へ
    // 再送し、その再送が (409 ではなく) 通常のネットワークエラー等で失敗した
    // 場合、このプロジェクトのエントリは前のターンのままなので誤って「今回も
    // 配信停止した」と
    // 判定してしまい、この再送自身が受け取った部分テキストが消えずに残る。
    // ローカル変数で「この送信自身が配信停止したか」だけを見る。
    //
    // bdboard-v3ag Opus レビュー指摘 (nit N1): 上で説明している「同じ会話への
    // 以前の未解決の配信停止が残っている」ケース自体、bdboard-v3ag 以降は
    // 単一タブの中では起こり得ない — submit(chat/useChatSubmit.ts)冒頭の
    // unresolvedProjectRecoveryAtSubmit ガードが、同じプロジェクトのエントリが
    // 存在する間はこの関数の呼び出しに到達する前に return するため。したがって
    // このローカル変数による判定は今のところ常にエントリの有無の判定と一致
    // するはず
    // だが、ガードを潜り抜ける経路が将来増えても壊れない防御としてそのまま
    // 残す(コード自体は変更しない、コメントのみ更新)。
    let detachedThisSend = false;
    try {
      const result = await postChatMessageStream(
        payload,
        {
          onDelta: (delta) =>
            setStreamingReply((prev) => ({
              ...prev,
              [sendKey]: (prev[sendKey] ?? '') + delta,
            })),
        },
        signal,
      );
      onSuccess(result);
      settleEarlierDetachedSend();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // unmount / スレッド切替 / プロジェクト切替由来の意図的 abort。
        // エラーバブルや入力欄復元は行わない。同一 project 内のスレッド
        // 切替では selectedProjectId が変わらないため、status 回収 effect を
        // generation で明示的に再起動する。
        setTurnRecoveryGeneration((generation) => generation + 1);
        // 回収が取りこぼしたときの安全網 (bdboard-3tw.156)。
        markUnresolvedSend(sessionId);
      } else if (error instanceof ChatStreamEndedWithoutResultError) {
        // bdboard-zlzo: サーバーが done/error を送らずに配信だけを止めた
        // (SSE キュー上限超過など)。ターンはサーバー側で完走・保存されるので、
        // 送信失敗として扱うとエラー表示と入力復元で再送 → 重複ターンを招く。
        // AbortError と同じく turn-status 回収へ流し、取りこぼしの安全網も張る。
        // 回収前に idle が見えたら完走しなかったので、そこで送信失敗に戻す。
        const detachedError = error;
        detachedThisSend = true;
        detachedStreamSendRef.current[projectId] = {
          sessionId,
          streamingKey: sendKey,
          detachedAt: Date.now(),
          fail: () => onFailure(new Error(CHAT_STREAM_DETACHED_FAILED_MESSAGE, { cause: detachedError })),
        };
        setTurnRecoveryGeneration((generation) => generation + 1);
        markUnresolvedSend(sessionId);
      } else {
        // bdboard-w26w: まだ接続中のクライアントがインライン SSE 'error' で
        // 受け取った失敗 (この else 分岐、ApiError(502, ...) 等。プリストリーム
        // の 409/400/404 やネットワーク断もここへ来るが、それらはサーバー側で
        // recordFailedTurn されていないので以下の ACK は素通りする) も、
        // 成功時の commitSuccess と対称に turn-status を ACK する。サーバーは
        // ChatAgentError を無条件で failedTurns へ記録する (recordFailedTurn、
        // finalizeChatTurnSuccess の隣の recordCompletedTurn と同型) ため、
        // ACK しないとこのエントリが CHAT_COMPLETED_TURNS_MAX の上限で押し
        // 出されるまで turn-status に残り続け、後から GET /api/chat/turn-status
        // を見る別クライアント/再接続後のこの会話がこの古い失敗を拾ってしまう
        // (この画面はすでにエラー表示済みなので二重に見る必要が無い)。
        // sessionId が無い場合 (新規スレッドの初回送信中の失敗) はサーバー側も
        // sessionId 無しで記録しており ACK できる識別子がクライアントに無いため、
        // 何もしない (キャップ eviction に任せる、FailedChatTurn の設計どおり)。
        //
        // Opus レビュー指摘 (finding 1): DELETE /api/chat/turn-status は同じ
        // sessionId の completed と failed を両方まとめて ACK する
        // (ackCompletedTurn + ackFailedTurn、chat-routes.ts)。isBusy はプロジェクト
        // 単位のロックなので、この送信 (N) の直前に「別の送信 (D) が配信停止し、
        // まだ回収 (turn-status 回収 effect のポーリング) が終わっていない」状態が
        // ありえ、しかも D と N が同じ会話 (同じ sessionId) を続けて送信した場合、
        // D はサーバー側では既に完走していて未 ACK の completedTurns エントリを
        // 残しているだけかもしれない。この状況で N の失敗をここで直接 ACK すると、
        // 本来は「D の回収」が先に処理すべきだった D の completed エントリまで
        // 巻き添えで消してしまい、次の poll が idle を見て D を「配信停止のまま
        // 失敗した」と誤判定する (実際には D は成功していたのに)。
        // detachedStreamSendRef が今まさに同じ project + sessionId を追っている
        // 間はここで直接 ACK せず、回収 effect 自身の完了優先の掃き出しロジック
        // (checkTurnStatus の completed 分岐 → 掃けたら再帰的に failed も掃く)
        // に任せる — 結果として少し遅れて ACK されるだけで、正しい優先順位
        // (completed を先に処理する) が保たれる。
        // bdboard-v3ag Opus レビュー指摘 (nit N1): 上の finding-1 シナリオ
        // (D が未回収のまま同じ会話へ N を送る) は、bdboard-v3ag 以降は単一タブ
        // では再現できない — 同じ理由 (submit 冒頭のガード) で、D が
        // 未回収である間はそもそも N をこの関数の中まで進められない。この分岐
        // 自体は「ガードを回避する経路が将来増えても安全」な防御としてそのまま
        // 残している。別タブ/別クライアントから見ても、detachedStreamSendRef は
        // タブ固有の ref (コンポーネントインスタンスのメモリ上) なので、他タブの
        // D をこのタブのガードが知ることはできない — その意味では cross-tab の
        // 防御にもなっていない。したがって現状はどちらのタブ内シナリオでも
        // 到達しない、意図した防御的デッドコードだと理解した上で残している。
        const unresolvedSameSessionDetach =
          detachedStreamSendRef.current[projectId] !== undefined &&
          detachedStreamSendRef.current[projectId].sessionId === sessionId;
        if (sessionId !== undefined && !unresolvedSameSessionDetach) {
          void acknowledgeChatTurn(projectId, sessionId).catch(() => {
            // ACK 失敗は turn-status に古い失敗エントリが残るだけ。表示は
            // このあとの commitFailure で既にエラーとして出る。
          });
        }
        onFailure(error);
      }
    } finally {
      // bdboard-3tw.166: この送信自身が配信停止した (上の
      // ChatStreamEndedWithoutResultError 分岐、detachedThisSend) 場合だけ、
      // ここではまだ消さない。turn-status 回収が確定する (completed の
      // ハイドレーション、または idle/failed からの fail()) まで、最後に
      // 受け取った部分テキストを表示し続ける ("回収中は最後に受け取った部分
      // テキストを表示し続ける" 要件)。それ以外 (成功 / この送信自身の通常失敗)
      // は従来どおり即座に消す。
      if (!detachedThisSend) {
        // bdboard-1qoe: この会話キーのぶんだけ消す (Record 全体を null にしない)。
        // 他の会話/プロジェクトがバックグラウンドで回収待ちの間に保持している
        // 部分テキストを、この送信の完了/通常失敗のたびに巻き添えで消していた
        // (単一スロットだった頃の元チケットのバグ)。
        clearStreamingReplyForKey(sendKey);
      }
    }
  } else {
    try {
      const result = await postChatMessage(payload, signal);
      onSuccess(result);
      settleEarlierDetachedSend();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setTurnRecoveryGeneration((generation) => generation + 1);
        markUnresolvedSend(sessionId);
      } else {
        onFailure(error);
      }
    }
  }
}
