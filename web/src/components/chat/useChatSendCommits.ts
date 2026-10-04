import { useCallback, type MutableRefObject } from 'react';
import { acknowledgeChatTurn, type ChatMessageResponseDto, type ChatThreadDto } from '../../api';
import { readPersistedChatThreads, writePersistedChatThread } from '../../chatThreadStorage';
import { referenceDraftPayloadStoreCarryPlan } from '../conversationKeyspace';
import type { ChatAttachment } from './attachments';
import { describeChatSendError } from './chatSendErrors';
import { APPLY_CHAT_SUCCESS_DRAFT_PAYLOAD_CARRY } from './draftCarryPlans';
import { toAssistantMessage, type ChatMessage } from './messages';
import {
  clearUnobservedOriginFor, persistedOpenBaseAfterCommit, planReplacedThread, withHistoryLoaded, type ReplacedThreadMarks,
} from './replacedThread';
import { appendSentThread, summarizeTitle } from './threads';
import type { UseChatConversationsStateResult } from './useChatConversationsState';
import type { UseChatDraftStateResult } from './useChatDraftState';
import type { UseChatThreadListsResult } from './useChatThreadLists';
import type { UseConversationKeyResult } from './useConversationKey';

export interface UseChatSendCommitsParams
  extends Pick<UseChatConversationsStateResult, 'setConversations' | 'setHistoryLoadedFor' | 'setThreadModelIds'>,
    Pick<
      UseChatThreadListsResult,
      'setThreadLists' | 'setOpenThreadIds' | 'openThreadIdsRef' | 'restoredProjectsRef' | 'provisionalEntries'
      | 'threadListOrder'
    >,
    Pick<UseConversationKeyResult, 'setSelectedThreadIds' | 'selectedThreadIdsRef'>,
    Pick<
      UseChatDraftStateResult,
      'conversationInputsRef' | 'conversationAttachmentsRef' | 'setInput' | 'updateConversationAttachments'
    > {
  selectedProjectId: string;
  showModelSelect: boolean;
  effectiveModelId: string;
  /** bdboard-drfb / bdboard-w9hv: 置き換えられたスレッドの判断材料(chat/replacedThread.ts)。 */
  replacedMarksRef: MutableRefObject<ReplacedThreadMarks>;
}

export interface UseChatSendCommitsResult {
  commitSuccess: (convKey: string, sentText: string, result: ChatMessageResponseDto) => void;
  commitFailure: (
    convKey: string,
    sentText: string,
    sentAttachments: readonly ChatAttachment[],
    error: unknown,
    sentAt: number,
  ) => void;
  appendTranscript: (convKey: string, message: ChatMessage, sessionId?: string) => void;
}

/**
 * bdboard-sso1.83 第13b段: 送信まわりで会話ストア・スレッド一覧・入力欄へ書く
 * store 側の action。commitSuccess は旧 applyChatSuccess、commitFailure は旧
 * applyChatError(ChatPanel.tsx)で、本体は変えていない。appendTranscript は旧
 * submitChatMessage が2箇所(利用不可エージェントのエラーバブル、楽観的な
 * ユーザー発話)で直接書いていた setConversations を1つにまとめたもの。
 * effect は持たない(useCallback だけ)。呼び出し位置は元の applyChatSuccess の位置。
 * 依存配列は完全(setter と ref は安定しているので、実際に変わるのは
 * selectedProjectId/showModelSelect/effectiveModelId だけ)。
 */
export function useChatSendCommits(params: UseChatSendCommitsParams): UseChatSendCommitsResult {
  const {
    selectedProjectId,
    showModelSelect,
    effectiveModelId,
    setConversations,
    setHistoryLoadedFor,
    setThreadModelIds,
    setThreadLists,
    setOpenThreadIds,
    openThreadIdsRef,
    restoredProjectsRef,
    provisionalEntries,
    threadListOrder,
    setSelectedThreadIds,
    selectedThreadIdsRef,
    conversationInputsRef,
    conversationAttachmentsRef,
    setInput,
    updateConversationAttachments,
    replacedMarksRef,
  } = params;

  const commitSuccess = useCallback(
    (convKey: string, sentText: string, result: ChatMessageResponseDto) => {
      // bdboard-ru4d: 会話キーの再割り当て(ドラフトキー → 確定 sessionId)だが、
      // ドラフト積載物は引き継がない(選択は APPLY_CHAT_SUCCESS_DRAFT_PAYLOAD_CARRY)。
      // 移すのは conversations(返信を追記した計算済みの値)のみ。
      referenceDraftPayloadStoreCarryPlan(APPLY_CHAT_SUCCESS_DRAFT_PAYLOAD_CARRY);
      // メモリの次の open は live ref から計算する(bdboard-d7on)。updater の外で ref を
      // 読み、setOpenThreadIds より前に確定させておく(下の永続化と同じ値を使うため)。
      const liveOpen = openThreadIdsRef.current[selectedProjectId];
      // bdboard-drfb: 再送が別のセッションへ移った(clearSession 後の再送が新しい sessionId を
      // 受け取った)とき、送信元の会話キー convKey が開いている実スレッドなら、そのスレッドは
      // この送信で置き換えられた(chat/replacedThread.ts。turn-status 回収の applyRecoveredTurn と
      // 同じ規則)。ドラフトキーは open に入らないので、ドラフトからの初回送信では当たらない。
      // 失敗時に印が付いていたら(unknown chat session)ここで消費する。同じ sessionId での
      // 成功でも消す(印を残さない)。置き換えが無い(ドラフトキー等)ときも消すだけ。
      const plan = planReplacedThread({
        convKey,
        newSessionId: result.sessionId,
        open: liveOpen,
        sessionGone: replacedMarksRef.current.goneKeys.delete(convKey),
      });
      // bdboard-w9hv: この送信が成功した以上、同じ会話キーの「結果を見届けられなかった」記録は不要。
      // 残すと、後の無関係な turn-status 回収が別のスレッドを置き換えとして閉じる。
      clearUnobservedOriginFor(replacedMarksRef.current, selectedProjectId, convKey);
      setConversations((prev) => {
        const next = {
          ...prev,
          [result.sessionId]: {
          messages: [
            ...(prev[convKey]?.messages ?? []),
            toAssistantMessage(result, Date.now()),
          ],
          sessionId: result.sessionId,
          agentId: result.agentId,
          },
        };
        if (convKey !== result.sessionId) delete next[convKey];
        return next;
      });
      // bdboard-pbf: ドラフトからの初回送信で新しい sessionId が確定した直後、
      // 下の setSelectedThreadIds でこのセッションが選択される。会話は今
      // ここで組み立てた最新状態なので履歴ロード済みとして扱わないと、
      // isHistoryPending が true のまま送信ボタンがロックされ続けてしまう
      // (履歴 effect は messages がある会話では early-return して
      // historyLoadedFor を立てないため)。
      // 置き換えられた実スレッド(plan.replacedKey)のロード済み印は外す(withHistoryLoaded)。
      // conversations[convKey] は sessionId が変われば常に消す(上)が、こちらは convKey が open の
      // とき(置き換え)だけ外す。差が出るのは open でない convKey だが、ドラフトには印が無く、
      // 送信中にスレッドを閉じると送信が abort されて commitSuccess まで来ないので、今のところ
      // 到達しない。外せば、再オープン時に死んでいれば 404 → handleHistorySessionGone で落ち、
      // 生きていれば(agent mismatch)履歴が戻る。
      setHistoryLoadedFor((prev) => withHistoryLoaded(prev, result.sessionId, plan.replacedKey));
      // bdboard-7feq: このプロジェクトの open が復元済み(restoredProjectsRef がマーク済み)で
      // live の open が分かるなら、永続化の open もメモリの次状態(plan.nextOpen)と
      // 同じにする。永続化済みエントリを基点にすると、初回訪問(エントリ無し)でメモリが
      // [A,B,C] のとき永続化が [D] に潰れ、リロードで A/B/C が黙って閉じられた。未復元
      // (初回一覧の読込中)は従来どおり永続化済みエントリを基点にする(bdboard-4w2d)。
      // 書き込みは setState の updater の外(StrictMode が updater を2回呼んでも二重に
      // 書かない)。open が 0 件でも plan.nextOpen は少なくとも新セッションを含む
      // ので、bdboard-rhl4 の「0 件なら [] を書く」とは干渉しない。
      // bdboard-drfb: 置き換えられたスレッド convKey は永続化の open にも残さない。復元済みなら
      // plan.nextOpen(convKey を除いてある)がそのまま基点になる。未復元の分岐は永続化済み
      // エントリが基点なので、置き換えが起きたときだけ、そのエントリから convKey(と、末尾へ
      // 足し直す新セッション)を除いた open を基点として渡す。未復元の分岐は初回訪問に加えて、
      // プロジェクトを訪れ直すたびに一覧の読込が終わるまで通る(useThreadListSync が訪問の頭で
      // 復元の印を外す)。置き換えが起きるのは clearSession 失敗と再送の成功の両方がその読込中に
      // 終わったときだけなので実際には稀だが、残すと再読み込みまで死んだ id が永続化に居座る。
      const persistedOpenBase = persistedOpenBaseAfterCommit({
        restored: restoredProjectsRef.current.has(selectedProjectId), liveOpen, plan, newSessionId: result.sessionId,
        readPersistedOpen: () => readPersistedChatThreads()[selectedProjectId]?.activeSessionIds ?? [],
      });
      // bdboard-rt6i: 未復元のプロジェクトで最初の永続化エントリ(それまでエントリが無い)を書くなら、それは利用者が
      // 開き閉じした記録ではなく仮のエントリ。印を立てる(chat/provisionalEntry.ts)。復元済み(エージェント切替で
      // 空に確定した後など)・エントリがあった再訪では立たない。2 回目以降の送信でも下ろさない。
      provisionalEntries.markIfFirstEntry(selectedProjectId);
      writePersistedChatThread(selectedProjectId, { sessionId: result.sessionId, agentId: result.agentId }, persistedOpenBase);
      if (showModelSelect && effectiveModelId !== '') {
        // 送信で実際に使われたモデルは常に確定値として勝つべきなので、ここだけは
        // 無条件で上書きする(履歴解決側の「未設定キーにだけ書く」ガードとは非対称)。
        setThreadModelIds((prev) => ({ ...prev, [result.sessionId]: effectiveModelId }));
      }
      // bdboard-drfb: unknown chat session 由来で置き換わったスレッド(plan.goneSessionId)は、サーバーに
      // 無いので一覧(閉じたスレッド)からも落とす。chat agent mismatch のスレッドは生きているので
      // 残し、ドロワーの「閉じたスレッド」から再オープンできるようにする。
      // bdboard-z9mn: この送信より前に始まった一覧 fetch(E7 の初回取得など)があとから届いても、送信した会話を
      // 一覧と open から落とさないよう、足すエントリを一覧の順序管理(chat/threadListFetchOrder.ts)に記録する。
      // 置き換えられた死んだスレッドの記録は捨てる(古い一覧で蘇らせない)。
      // 既存スレッドへの送信(convKey === result.sessionId)は記録しない。そのスレッドは送信前からサーバーの
      // 一覧に載っている。このエントリはタイトルを今回の送信文・pinned を false にした仮の値なので、記録すると
      // 古い一覧が持つ正しいタイトル(リネーム済みなら付けた名前、未設定なら最初の発言)とピン留めを潰す。
      // bdboard-b1rz: 一覧(threadLists)に載せる行は、上の order の記録とは別の条件で決まる。order に記録するかは
      // セッションが新しいか(convKey !== result.sessionId)で決まり、行に載せる値は既存行があるかで決まる。
      // 既存行があれば appendSentThread が題名とピンを残し(題名が null の行だけは送った文で埋める)、updatedAt だけ進める。
      // bdboard-qd78: 空の題名はここで null にする。order の記録(古い一覧の admit で足される)も同じ値を持つため。
      const listEntry: ChatThreadDto = {
        sessionId: result.sessionId, agentId: result.agentId, title: summarizeTitle(sentText) || null, pinned: false,
        updatedAt: new Date().toISOString(),
      };
      if (convKey !== result.sessionId) threadListOrder.noteEntryWrite(selectedProjectId, listEntry, 'upsert');
      if (plan.goneSessionId !== undefined) threadListOrder.forgetEntry(selectedProjectId, plan.goneSessionId);
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: appendSentThread(prev[selectedProjectId] ?? [], listEntry, plan.goneSessionId),
      }));
      setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: plan.nextOpen }));
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: result.sessionId }));
      // ここでは未回収の印を外さない (PR#135 レビュー minor-1)。
      // 通常の成功では印はそもそも立っていない (印を立てるのは abort の catch だけ)
      // ので、外して意味があるのは「見届けられなかったスレッドへ戻り、取り直しが
      // 当たる前に次を送信した」場合だけ。その場合の取りこぼし返信はまだローカルに
      // 入っておらず、ここで外すと二度と取りに行かなくなる。印は取り直しが実際に
      // 当たったときにだけ外す。
      void acknowledgeChatTurn(selectedProjectId, result.sessionId).catch(() => {
        // The reply is already incorporated. A failed ACK only causes safe re-hydration later.
      });
    },
    [
      effectiveModelId,
      selectedProjectId,
      showModelSelect,
      setConversations,
      setHistoryLoadedFor,
      setThreadModelIds,
      setThreadLists,
      setOpenThreadIds,
      openThreadIdsRef,
      restoredProjectsRef,
      provisionalEntries,
      threadListOrder,
      setSelectedThreadIds,
      selectedThreadIdsRef,
      replacedMarksRef,
    ],
  );

  const commitFailure = useCallback(
    (
      convKey: string,
      sentText: string,
      sentAttachments: readonly ChatAttachment[],
      error: unknown,
      sentAt: number,
    ) => {
      // bdboard-sso1.83 第4段: エラー種別 → 文言/clearSession の判定は
      // chat/chatSendErrors.ts の describeChatSendError へ移した。分岐の順番・
      // 条件・文言は変えていない。
      const { text: errorText, clearSession, sessionGone } = describeChatSendError(error);
      // bdboard-drfb: 再送が成功して別セッションへ移ったとき(commitSuccess)に、死んだスレッドを
      // 一覧からも落とす判断材料。agent mismatch (sessionGone=false) は印を付けない。
      if (sessionGone) replacedMarksRef.current.goneKeys.add(convKey);

      setConversations((prev) => {
        const current = prev[convKey] ?? { messages: [] };
        // bdboard-sp2(議長裁定 方針(a)): 送信は成立しなかった — 楽観的に積んだ
        // ユーザーメッセージを transcript から取り消し、本文は下の入力欄復元で返す。
        // 取り消さないと失敗直後に transcript と入力欄で同じ本文が二重表示され、
        // 1クリック再送で transcript にユーザー発話が二重に積まれる。
        const messagesWithoutOptimisticUser = current.messages.filter(
          (message) => !(message.role === 'user' && message.at === sentAt),
        );
        return {
          ...prev,
          [convKey]: {
            messages: [
              ...messagesWithoutOptimisticUser,
              { role: 'error', text: errorText, at: Date.now() },
            ],
            sessionId: clearSession ? undefined : current.sessionId,
            agentId: clearSession ? undefined : current.agentId,
          },
        };
      });
      // bdboard-jwu8: clearSession (unknown chat session / chat agent mismatch) でも、
      // このプロジェクトの永続化 (localStorage) には触らない。以前はここでエントリを丸ごと
      // 消していたが、失敗したのはこの送信1回だけで、メモリ上の openThreadIds/
      // selectedThreadIds はどちらも変わらない。消すと保存とメモリが食い違い、次回訪問
      // (またはプロジェクトを切り替えて戻る) で「エントリ無し = 初回訪問」と判定されて、
      // 閉じたスレッドまで全部開き直していた (bdboard-ij6e / bdboard-rhl4 と同じ根)。
      // 選択も書き換えない: unknown chat session ならそのセッションはサーバーの一覧から
      // 消えており、復元時に restoreThreadView が選択を落とす。agent mismatch なら
      // セッションは生きていてメモリ上も選択中のままなので、保存側だけ外すとずれる
      // (PR #821 の Fable レビュー指摘1)。

      // bdboard-otf(bdboard-dpq レビュー N2 フォローアップ): 送信失敗時に入力欄へ
      // 本文を復元する。送信時のクリア(chat/useChatSubmit.ts の submit、try の前)は失敗しても巻き戻ら
      // ないため、送信をやり損ねた本文がそのまま消えていた。復元先は convKey ——
      // 呼び出し元(chat/useChatSubmit.ts の submit)がクロージャで捕まえた「送信時点の会話キー」
      // (sendKey)であり、現在表示中のキー(currentConversationKey)ではない。
      // 送信中にユーザーがスレッド/プロジェクトを切り替えていた場合、現在の入力欄
      // ではなく元のキーへ復元することで、現在の入力欄を汚染しない。
      // sentText は handleSubmit → submit が渡す trim 前の本文(SF2、Opus レビュー) —
      // プリフィル文言(例: `${ticketId} について: `)は末尾に半角スペースを
      // 含む形式が本番で実在するため、trim 済みの値を復元すると下の SF1 の
      // 「未編集シードの復元は seed 記録を維持する」判定が壊れる(復元値が
      // draftSeedTextRef の末尾スペース込みシード文言と一致しなくなるため)。
      // N5(Opus レビュー): 送信中にこの convKey 自体が(新規ドラフト採番などで)
      // どこからも表示されなくなっていた場合、復元した本文もこのエラー
      // メッセージ(上で conversations[convKey] へ積んだもの)も、以後どの UI
      // 操作からも到達できない。ただしこれは base(このチケット以前)でも本文が
      // 失われていた状況と同じであり、挙動の劣化ではない — 到達可能な場合の
      // 復元漏れを防ぐのがこの変更の目的で、到達不能キーへの保証までは範囲外。
      //
      // 上書き防止(dpq「書きかけ本文を消さない」不変条件): 失敗するまでの間に
      // ユーザーが同じ convKey へ新しい本文を打ち込んでいた場合、送信文言で
      // それを上書きしてはいけない。conversationInputsRef(現在値を stale
      // closure なしで読むための ref ミラー、ChatPanel.tsx や useChatDraftState の他の利用箇所と
      // 同じパターン)を見て、該当キーが空のときだけ復元する。
      // N4(Opus レビュー): 現状の UI では isSending の間 textarea/各 select が
      // すべて disabled になるため、送信中にこの convKey(=sendKey)へ新しい本文を
      // 書き込める手段は実際には存在せず、このガードは現状到達しない防御的
      // コードである。将来 disabled 制御を緩める変更が入ったときの保険として
      // 残す(ガードとそれを固定する回帰テストは維持する)。
      // bdboard-zlzo: 配信停止後の失敗判定 (detachedStreamSendRef の fail) は
      // isSending が落ちた後に非同期で届くため、このガードへ実際に到達する。
      //
      // SF1(Opus レビュー): ここで draftSeedTextRef.current[convKey] を delete
      // しては**いけない**。104.17 の isUserEdit は「ユーザーが書いた本文を
      // システムシードとして記録するな」という規則だが、この復元が上書きする
      // ケース(conversationInputsRef.current[convKey] === '')は、そもそも「未編集
      // のプリフィルをそのまま送信して失敗した」場合そのものであり、復元される
      // sentText は元のシード文言と一致する(=正真正銘のシード)。ここで delete
      // すると、次にこの convKey に対して startNewDraftThread 等の「値がシード
      // 文言のままなら未編集」判定が働いたとき、記録が失われているせいで
      // 無条件に「編集済み」とみなされ、後続のプリフィル適用が無言で捨てられて
      // 古い文言が居座ってしまう(実測で確認)。ユーザーが実際に編集していた
      // ケースでは draftSeedTextRef は古いプリフィルのままなので、delete しなくても
      // `value !== seed` により正しく「編集済み」と判定される — つまり delete
      // 無しの現状のまま(=既存の記録を変更しない)で両ケースとも正しい。
      if ((conversationInputsRef.current[convKey] ?? '') === '') {
        setInput(convKey, sentText);
      }
      // 本文と同じく送信元キーへだけ戻し、送信後に同じキーへ新しい添付が
      // 置かれていた場合は上書きしない。AbortError はこの関数へ来ない。
      if (
        sentAttachments.length > 0 &&
        (conversationAttachmentsRef.current[convKey]?.length ?? 0) === 0
      ) {
        updateConversationAttachments((prev) => ({
          ...prev,
          [convKey]: [...sentAttachments],
        }));
      }
    },
    [
      selectedProjectId,
      setConversations,
      updateConversationAttachments,
      conversationInputsRef,
      conversationAttachmentsRef,
      setInput,
      replacedMarksRef,
    ],
  );

  const appendTranscript = useCallback(
    (convKey: string, message: ChatMessage, sessionId?: string) => {
      setConversations((prev) => ({
        ...prev,
        [convKey]: {
          ...prev[convKey],
          ...(sessionId !== undefined ? { sessionId } : {}),
          messages: [...(prev[convKey]?.messages ?? []), message],
        },
      }));
    },
    [setConversations],
  );

  return { commitSuccess, commitFailure, appendTranscript };
}
