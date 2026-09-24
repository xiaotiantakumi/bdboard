import { useCallback, useRef } from 'react';
import { applyDraftPayloadStoreCarryPlan, referenceDraftPayloadStoreCarryPlan } from '../conversationKeyspace';
import { writePersistedChatThread } from '../../chatThreadStorage';
import { type ChatAttachment } from './attachments';
import { makeDraftKey } from './draftKey';
import {
  HANDLE_AGENT_CHANGE_DRAFT_PAYLOAD_CARRY,
  START_NEW_DRAFT_THREAD_CARRY,
  START_NEW_DRAFT_THREAD_PREFILL_CARRY,
} from './draftCarryPlans';
import type { UseChatAgentModelStateResult } from './useChatAgentModelState';
import type { UseChatConversationsStateResult } from './useChatConversationsState';
import type { UseChatDraftStateResult } from './useChatDraftState';
import type { UseChatThreadListsResult } from './useChatThreadLists';
import type { UseConversationKeyResult } from './useConversationKey';

export interface UseDraftThreadLauncherParams
  extends Pick<UseConversationKeyResult, 'currentConversationKey' | 'draftNoncesRef' | 'setDraftNonces' | 'setSelectedThreadIds'>,
    Pick<
      UseChatConversationsStateResult,
      'historyRequestIdRef' | 'setConversations' | 'setHistoryLoadedFor' | 'setLoadingHistoryFor' | 'setThreadModelIds'
    >,
    Pick<UseChatDraftStateResult, 'conversationInputsRef' | 'conversationAttachmentsRef' | 'draftSeedTextRef'>,
    Pick<
      UseChatDraftStateResult,
      'setInput' | 'updateConversationInputs' | 'updateConversationAttachments' | 'clearAttachmentError'
    >,
    Pick<UseChatThreadListsResult, 'setOpenThreadIds'>,
    Pick<UseChatAgentModelStateResult, 'setSelectedAgentId'> {
  selectedProjectId: string;
  cancelThreadConfirmDelete: () => void;
}

/**
 * bdboard-sso1.83 第14b段: ChatPanel.tsx から「新しいドラフトスレッドを起こす」側
 * (保留中のプリフィルとチケット起動の pending ref、startNewDraftThread、
 * handleNewThread(SF5)、handleAgentChange)を move-only で抜き出したもの。
 * effect は持たない(useRef と useCallback だけ)。呼び出し位置は元の
 * startNewDraftThread の位置。
 *
 * pending ref は2つとも[正本]: ChatPanel の ticket-context effect(E9)が積み、
 * スレッド一覧 effect(E7)が無効化・消化し、ここの startNewDraftThread が消化し、
 * handleNewThread が消去する。state から作り直してはいけない。
 */
export function useDraftThreadLauncher(params: UseDraftThreadLauncherParams) {
  const { selectedProjectId, currentConversationKey, draftNoncesRef, setDraftNonces, setSelectedThreadIds } = params;
  const { historyRequestIdRef, setConversations, setHistoryLoadedFor, setLoadingHistoryFor, setThreadModelIds } = params;
  const { conversationInputsRef, conversationAttachmentsRef, draftSeedTextRef, setInput } = params;
  const { updateConversationInputs, updateConversationAttachments, clearAttachmentError } = params;
  const { setOpenThreadIds, setSelectedAgentId, cancelThreadConfirmDelete } = params;
  // MF1/SF2 一括解消: 「これから採番される nonce」を先読みして直接
  // conversationInputs へ書き込む旧実装(未来ドラフトキーの先読み予測)は廃止した。
  // ticketContextToken 由来のプリフィル文言と、プロジェクト解決前に貼られた画像は
  // 常にここへ「対象プロジェクト+ドラフト内容」を積んでおき、実際にその
  // プロジェクトのドラフトキーが startNewDraftThread
  // によって採番されたタイミングでのみ消化する(下記 startNewDraftThread 参照)。
  // これにより、遅延適用の窓(プロジェクトを跨ぐ場合やスレッド一覧 fetch 未完了の
  // 場合)で他の要因により nonce がずれても、予測ズレによる孤児エントリが原理的に
  // 発生しない。SF1: この消化タイミングで、直前のドラフト(旧キー)がユーザーに
  // よって編集されていれば、プリフィルではなく旧キーの値を優先して引き継ぐ
  // (詳細は ChatPanel.tsx の draftSeedTextRef の説明と startNewDraftThread 内のコメント)。これにより
  // 「窓の間にユーザーが編集した本文が消化時に無言でプリフィルへ巻き戻る」
  // 退行を防いでいる。
  //
  // マウント時点の initialInput(nonce 0 の初期シード、chat/useChatDraftState.ts の
  // conversationInputs 参照)は意図的にここへは積まない: nonce 0 は「これから採番される」ものではなく
  // 初回レンダーの時点で確定している唯一のドラフトキーなので、
  // pendingPrefillRef を経由しなくても予測ズレは起こり得ない。ここに混ぜると
  // 「pendingPrefillRef が非 null で始まる」ケースが生まれ、StrictMode の開発時
  // ダブルレンダー(mount→cleanup→mount で effect が二重発火する)との整合を
  // 取るための追加の仕組みが必要になる(実際に試して壊れた)。ticketContextToken
  // 側の effect が実際に発火するまでは null のままで十分。
  // 104.17 Opus レビュー should-fix1: isUserEdit はこのプリフィルが(システムの
  // 文言ではなく)コールドウィンドウ中のユーザー編集そのものであることを示す。
  // 消化側(startNewDraftThread)がこれを見て draftSeedTextRef への「システム
  // シード」記録を抑止する(詳細はそちら側のコメント)。
  const pendingPrefillRef = useRef<{
    projectId: string;
    text: string;
    isUserEdit?: boolean;
    modelId?: string;
    attachments?: readonly ChatAttachment[];
  } | null>(null);
  const pendingTicketDraftProjectRef = useRef<string | null>(null);

  // 不変条件(N1): この関数を同一 tick 内(同期的なコールバック連鎖の中)で同じ
  // projectId に対して2回呼ぶと、両方とも同じ draftNoncesRef.current[projectId]
  // を読んでから +1 するため nonce が衝突し、2つのドラフトが同じ会話キーを
  // 奪い合う。呼び出し側(ChatPanel.tsx の各 useEffect)は必ず「1回のトリガーにつき
  // startNewDraftThread は高々1回」を守ること。
  const startNewDraftThread = useCallback((projectId: string) => {
    // bdboard-ru4d: ここも会話キーの再割り当てサイト。引き継ぎ選択は
    // START_NEW_DRAFT_THREAD_*_CARRY で型網羅を強制している。
    const previousDraftNonce = draftNoncesRef.current[projectId] ?? 0;
    const previousDraftKey = makeDraftKey(projectId, previousDraftNonce);
    const nextDraftNonce = previousDraftNonce + 1;
    const nextDraftKey = makeDraftKey(projectId, nextDraftNonce);
    setSelectedThreadIds((prev) => ({ ...prev, [projectId]: undefined }));
    setDraftNonces((prev) => ({ ...prev, [projectId]: nextDraftNonce }));
    setHistoryLoadedFor((prev) => ({
      ...prev,
      [nextDraftKey]: true,
    }));
    cancelThreadConfirmDelete();
    // MF1/SF1/SF2: ここが会話キーの nonce を実際に採番する唯一の場所なので、
    // 保留中のプリフィル(pendingPrefillRef、対象プロジェクトが一致する場合のみ)
    // をこのタイミングで、いま採番した本物のドラフトキーへ消化する。呼び出し元
    // (ticket-context effect からの即時呼び出し・スレッド一覧 fetch 側での
    // pending 消化・handleNewThread のいずれでも)を問わず同じ経路を通るため、
    // 未来のキーを先読み予測する必要が無く、予測ズレによる孤児エントリも
    // 発生しない。「新規スレッド」ボタン(handleNewThread)からの呼び出しでは
    // SF5 により pendingPrefillRef が事前にクリアされるので、この分岐は素通りし、
    // 従来どおり空の新規ドラフトになる。
    if (
      pendingPrefillRef.current !== null &&
      pendingPrefillRef.current.projectId === projectId
    ) {
      const prefillText = pendingPrefillRef.current.text;
      // 104.17 Opus レビュー should-fix1: このプリフィルがシステムの文言では
      // なく、コールドウィンドウ中にユーザーが実際にタイプした本文そのもので
      // ある場合(104.17 の cold-key 引き継ぎ、ticket-context effect 側で
      // isUserEdit を立てる)、それは「システムがシードした文言」ではないので
      // draftSeedTextRef へシード記録してはいけない。記録してしまうと、次に
      // 同じチケットが再び開かれたとき(token 2 など)、下の SF1 判定が
      // 「draftSeedTextRef と現在値が一致する = 未編集」と誤断し、今まさに
      // 保持したはずのユーザー本文を次のプリフィルで無言上書きしてしまう。
      const prefillIsUserEdit = pendingPrefillRef.current.isUserEdit === true;
      const prefillModelId = pendingPrefillRef.current.modelId;
      const prefillAttachments = pendingPrefillRef.current.attachments ?? [];
      pendingPrefillRef.current = null;
      // SF1(N1: handleAgentChange の書きかけ本文引き継ぎと同じ family ——
      // 「表示キーが切り替わるなら、旧キーの編集を新キーへ引き継ぐ」という不変
      // 条件): pendingPrefillRef 消化で置き換えられる旧ドラフト(previousDraftKey)
      // が、プリフィルの窓(fetch 待ちなど)の間にユーザーによって編集・追記され
      // ていた場合、無条件でプリフィルを上書き適用するとその編集を無言で失わせて
      // しまう(bdboard-dpq の趣旨に反する退行)。draftSeedTextRef(旧キーが最後に
      // システムによってシードされたときの文言)と旧キーの現在値を比べ、両者が
      // 食い違っていれば「ユーザーが編集した」とみなしてプリフィルではなく旧キー
      // の値をそのまま新キーへ引き継ぐ。旧キーが空、またはシード時のままなら
      // (=誰も編集していない)従来どおりプリフィルを適用する。
      const previousValue = conversationInputsRef.current[previousDraftKey] ?? '';
      const previousSeedText = draftSeedTextRef.current[previousDraftKey];
      const previousValueIsUneditedSeed =
        previousValue === '' || previousValue === previousSeedText;
      const textToApply = previousValueIsUneditedSeed ? prefillText : previousValue;
      const liveAttachments = conversationAttachmentsRef.current[previousDraftKey] ?? [];
      const attachmentsToCarry = liveAttachments.length > 0
        ? liveAttachments
        : prefillAttachments;
      applyDraftPayloadStoreCarryPlan(START_NEW_DRAFT_THREAD_PREFILL_CARRY, {
        conversationInputs: () => {
          setInput(nextDraftKey, textToApply);
        },
        conversationAttachments: () => {
          if (attachmentsToCarry.length > 0) {
            updateConversationAttachments((prev) => ({
              ...Object.fromEntries(
                Object.entries(prev).filter(([key]) => key !== previousDraftKey),
              ),
              [nextDraftKey]: [...attachmentsToCarry],
            }));
          }
        },
        draftSeedText: () => {
          if (textToApply === prefillText && !prefillIsUserEdit) {
            draftSeedTextRef.current[nextDraftKey] = prefillText;
          } else {
            delete draftSeedTextRef.current[nextDraftKey];
          }
        },
        threadModelIds: () => {
          if (prefillModelId !== undefined) {
            setThreadModelIds((prev) => ({ ...prev, [nextDraftKey]: prefillModelId }));
          }
        },
      });
    } else {
      referenceDraftPayloadStoreCarryPlan(START_NEW_DRAFT_THREAD_CARRY);
    }
    // N2: ドラフトへの切り替えは意図的に writePersistedChatThreadState を呼ばない。
    // ドラフトはセッションIDを持たない(非永続)ので、localStorage の
    // selectedSessionId をここで書き換える対象が無い — 既存の永続化済み選択は
    // そのまま(次回訪問時にまた同じ既存スレッドへ戻れるように)残す。
  }, [
    updateConversationAttachments, cancelThreadConfirmDelete, conversationInputsRef, conversationAttachmentsRef,
    draftSeedTextRef, setInput,
    // 第14b段: フックの引数になったので exhaustive-deps が求める分を加えた。
    // ref と useState の setter だけなので、参照は変わらない。
    draftNoncesRef, setDraftNonces, setSelectedThreadIds, setHistoryLoadedFor, setThreadModelIds,
  ]);

  const handleAgentChange = useCallback(
    (nextId: string) => {
      // モデル選択のリセットはここでは行わない。selectedAgent を見る useEffect が
      // 一箇所で担当する(同じ規則を2箇所に持つと片方だけ直す drift が起きる)。
      historyRequestIdRef.current += 1;
      setLoadingHistoryFor(null);
      writePersistedChatThread(selectedProjectId, undefined);
      setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: [] }));
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: undefined }));
      const nextDraftNonce = (draftNoncesRef.current[selectedProjectId] ?? 0) + 1;
      const nextDraftKey = makeDraftKey(selectedProjectId, nextDraftNonce);
      // bdboard-ru4d: 会話キーの再割り当て。引き継ぎ選択は
      // HANDLE_AGENT_CHANGE_DRAFT_PAYLOAD_CARRY で型網羅を強制している。
      setDraftNonces((prev) => ({ ...prev, [selectedProjectId]: nextDraftNonce }));
      // MF1(N1: startNewDraftThread の SF1 引き継ぎと同じ family ——
      // 「表示キーが切り替わるなら、旧キーの編集を新キーへ引き継ぐ」という
      // 不変条件): エージェント切替は会話キーを強制的に新しいドラフトへ進める
      // が、その瞬間まで入力欄にあった書きかけの本文(既存スレッド閲覧中でも
      // ドラフト中でも)はユーザーがまだ送信していない作業なので、失わせず
      // 新しいドラフトキーへ引き継ぐ。「新規スレッド」ボタン
      // (handleNewThread→startNewDraftThread)は明示的な新規作成の意図なので、
      // こちらは従来どおり引き継がず空のドラフトのままにする。
      applyDraftPayloadStoreCarryPlan(HANDLE_AGENT_CHANGE_DRAFT_PAYLOAD_CARRY, {
        conversationInputs: () => {
          // opus レビュー(bdboard-sso1.83): ref 読み取り(最後にレンダーされた
          // state)ではなく、元実装と同じく prev を関数で読む形にする —
          // 同一バッチ内に別の pending な入力更新があった場合でも、それを
          // 取りこぼさず引き継ぐため(updateConversationAttachments 直下と同じ
          // 理由)。
          updateConversationInputs((prev) => ({
            ...prev,
            [nextDraftKey]: prev[currentConversationKey] ?? '',
          }));
        },
        conversationAttachments: () => {
          updateConversationAttachments((prev) => {
            const moved = [...(prev[currentConversationKey] ?? [])];
            const next = { ...prev };
            delete next[currentConversationKey];
            return { ...next, [nextDraftKey]: moved };
          });
        },
        draftSeedText: () => {
          // SFX: 値と一緒に draftSeedTextRef のシード記録も無条件でコピーする。
          // 値だけコピーしてシード記録を移し忘れると、新キーでは
          // draftSeedTextRef.current[nextDraftKey] が undefined のままになり、後で
          // startNewDraftThread がこの新キーを previousDraftKey として比較する際
          // 「シード記録が無い」→無条件で「編集済み」と誤判定してしまう。
          if (currentConversationKey in draftSeedTextRef.current) {
            draftSeedTextRef.current[nextDraftKey] =
              draftSeedTextRef.current[currentConversationKey];
          } else {
            delete draftSeedTextRef.current[nextDraftKey];
          }
        },
      });
      setSelectedAgentId(nextId);
      setConversations((prev) => {
        const current = prev[currentConversationKey];
        if (current === undefined) {
          return prev;
        }
        return {
          ...prev,
          [currentConversationKey]: {
            ...current,
            sessionId: undefined,
            agentId: undefined,
          },
        };
      });
    },
    [
      selectedProjectId, currentConversationKey, updateConversationAttachments, updateConversationInputs,
      draftSeedTextRef, setSelectedAgentId,
      // 第14b段: 上と同じ理由で加えた(ref と useState の setter だけ)。
      historyRequestIdRef, setLoadingHistoryFor, setOpenThreadIds, setSelectedThreadIds,
      draftNoncesRef, setDraftNonces, setConversations,
    ],
  );

  const handleNewThread = () => {
    // SF5: pendingPrefillRef/pendingTicketDraftProjectRef の消化窓
    // (チケット文脈からの起動でスレッド一覧 fetch がまだ終わっていない間)に
    // ユーザーが自分で「新規スレッド」を押した場合、ユーザーの明示的な空ドラフト
    // 要求が保留中のチケット文脈の意図に優先する。ここでクリアせずに
    // startNewDraftThread を呼ぶと、(a) このタイミングで pendingPrefillRef が
    // 誤って消化されチケット文言がこの新規ドラフトに混入し、(b) さらに後で
    // fetch が解決した際 pendingTicketDraftProjectRef が selectedProjectId と
    // まだ一致しているせいで startNewDraftThread がもう一度呼ばれて nonce が
    // 二重に進み、しかも pendingPrefillRef は (a) で既に消費済みのためプリフィル
    // が結局どのドラフトにも表示されない、という二重の不整合が起きる。
    pendingPrefillRef.current = null;
    pendingTicketDraftProjectRef.current = null;
    updateConversationAttachments((prev) => {
      if (!(currentConversationKey in prev)) return prev;
      const next = { ...prev };
      delete next[currentConversationKey];
      return next;
    });
    clearAttachmentError(currentConversationKey);
    startNewDraftThread(selectedProjectId);
  };

  // bdboard-23u: 死んだセッションからの自動回復(ChatPanel の
  // handleHistorySessionGone、E12 の onSessionGone)での nonce の前進。
  // handleAgentChange と同じインラインの nonce 前進パターンに揃える
  // (pendingPrefillRef の消化などプリフィル固有の副作用を伴う
  // startNewDraftThread は、ユーザー起因でないこの自動回復では意図的に
  // 呼ばない)。参照は安定させること: handleHistorySessionGone を経由して
  // E12 の依存配列に入る。
  const advanceDraftNonceAfterSessionGone = useCallback(
    (projectId: string) => {
      const nextDraftNonce = (draftNoncesRef.current[projectId] ?? 0) + 1;
      setDraftNonces((prev) => ({ ...prev, [projectId]: nextDraftNonce }));
    },
    [draftNoncesRef, setDraftNonces],
  );

  return {
    pendingPrefillRef, pendingTicketDraftProjectRef, startNewDraftThread,
    handleNewThread, handleAgentChange, advanceDraftNonceAfterSessionGone,
  };
}
