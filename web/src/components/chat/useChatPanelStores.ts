// bdboard-sso1.83 第15b段: ChatPanel.tsx のフック配線を controller
// (chat/useChatPanelController.ts)へ移したときの4区間のうち1つ目。
// 元の ChatPanel.tsx 99〜305 行目を行単位でそのまま(コメントごと)移した。
// 呼び出し順は ChatPanel の useRef 群 → この区間 → useChatPanelAgentAndLauncher で、元の並びと同じ。
// 前の区間の戻り値は controller が params に spread して渡す。
import { useState } from 'react';
import type { ChatPanelControllerParams } from './chatPanelTypes';
import { resolveInitialProjectId } from './projectSelection';
import { useChatConversationsState } from './useChatConversationsState';
import { useChatDraftState } from './useChatDraftState';
import { useChatNotifications } from './useChatNotifications';
import { useChatSendState } from './useChatSendState';
import { useChatThreadLists } from './useChatThreadLists';
import { useConversationKey } from './useConversationKey';
import { useThreadDrawerState } from './useThreadDrawerState';

/**
 * ChatPanel の state を持つフック群(選択中プロジェクト、会話ストア、会話キー、送信状態、
 * ドロワー、通知、スレッド一覧、下書き)を元の useState の位置の順で呼ぶ。effect を持つ
 * フックは無い(設計書 §4b-1 の「state フック」側)。
 */
export function useChatPanelStores(params: ChatPanelControllerParams) {
  const { projects, initialProjectId, initialInput, inputRef, formRef } = params;
  const [selectedProjectId, setSelectedProjectId] = useState(() =>
    resolveInitialProjectId(projects, initialProjectId),
  );
  const {
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
  } = useChatConversationsState();
  // bdboard-sso1.83 第10段: selectedThreadIds/draftNonces と、そこから計算する
  // currentSessionId/currentConversationKey(+ stale-closure 回避用の ref ミラー)を
  // chat/useConversationKey.ts へ move-only で抜き出した(旧第2段のコメントが
  // 説明していた「呼び出し順・依存配列に影響しない独立した useState/派生値」と
  // いう性質はそのまま、宣言場所だけがフックの中へ移った)。selectedThreadIds/
  // draftNonces 自体(Record 全体)はこのコンポーネント側では直接読まれなくなった
  // ため分割代入しない(setter と ref ミラー、および派生値だけを受け取る)。
  const {
    setSelectedThreadIds,
    selectedThreadIdsRef,
    setDraftNonces,
    draftNoncesRef,
    currentSessionId,
    currentConversationKey,
    currentConversationKeyRef,
  } = useConversationKey(selectedProjectId);
  const send = useChatSendState();
  const {
    isSending,
    streamingReply,
    turnRecoveryGeneration,
    unresolvedSends,
    clearUnresolvedSend,
    clearStreamingReplyForKey,
    detachedStreamSendRef,
    requestAbortControllerRef,
  } = send;
  // Chat Redesign 1b: タブ帯を捨て、スレッド切り替えは「現在のスレッド名+件数」
  // ボタン1つ→ドロワー(縦一覧)へ集約する。ドロワーの開閉・行の「⋯」操作メニュー・
  // リネーム確定・削除確認・CLIセッション発見一覧の表示は互いに絡み合う相互排他の
  // UI 状態なので、bdboard-sso1.83 でひとつの useReducer (chat/threadDrawerState.ts)
  // へ畳んだ。個々の状態名(threadDrawerOpen 等)はこの後の分割代入で読み取り側の
  // 変数名を維持しているため、以降の参照箇所は変わらない。
  const {
    state: {
      drawerOpen: threadDrawerOpen,
      menuSessionId: threadActionMenuSessionId,
      renamingSessionId,
      renameDraft,
      confirmingDeleteSessionId,
      showDiscoveredSessions,
    },
    toggleDrawer: toggleThreadDrawer,
    closeDrawer: closeThreadDrawer,
    selectThread: selectThreadDrawerThread,
    toggleMenu: toggleThreadActionMenu,
    closeMenu: closeThreadActionMenu,
    startRename: startThreadRename,
    changeRenameDraft: setRenameDraft,
    cancelRename: cancelThreadRename,
    startConfirmDelete: startThreadConfirmDelete,
    cancelConfirmDelete: cancelThreadConfirmDelete,
    cancelInteractionsForSession: cancelThreadInteractionsForSession,
    toggleDiscoveredSessions: toggleShowDiscoveredSessions,
    closeDiscoveredSessions: closeShowDiscoveredSessions,
  } = useThreadDrawerState();
  // bdboard-sso1.83 第3段: threadError/ticketProjectFallbackNotice を
  // chat/useChatNotifications.ts へ抜き出した(詳細はそちら参照)。
  const { threadError, setThreadError, ticketProjectFallbackNotice, setTicketProjectFallbackNotice } =
    useChatNotifications();
  // bdboard-sso1.83 第10段: threadLists/openThreadIds の state と、開閉・選択・
  // 削除・リネーム・ピン留めの各操作を chat/useChatThreadLists.ts へ move-only で
  // 抜き出した。呼び出し位置は元の useState(このファイル冒頭)より後ろにずれて
  // いる — ドロワーの useReducer(上の useThreadDrawerState)の戻り値(drawer
  // callbacks/renameDraft)と useChatNotifications の setThreadError に依存する
  // ため。effect は持たない(スレッド一覧 fetch effect 自体は会話キー再割り当て
  // クラスタ第14d段で chat/useThreadListSync.ts へ移した)。closeThread/
  // deleteThread/renameThread/togglePin は元の handleCloseThread/
  // handleDeleteThread/handleRenameConfirm/handlePinToggle と同じ関数として
  // 参照できるよう分割代入でエイリアスする(以降の参照箇所・コメント中の関数名は
  // 変えていない)。
  const {
    setThreadLists,
    openThreadIds,
    setOpenThreadIds,
    openThreadIdsRef,
    openThreads,
    threadById,
    displayedOpenThreads,
    closedThreads,
    hasClosedThreads,
    currentThreadTitle,
    closeThread: handleCloseThread,
    selectOpenThread,
    reopenClosedThread,
    deleteThread: handleDeleteThread,
    renameThread: handleRenameConfirm,
    togglePin: handlePinToggle,
  } = useChatThreadLists({
    selectedProjectId,
    currentSessionId,
    setSelectedThreadIds,
    setThreadError,
    renameDraft,
    drawer: {
      selectThread: selectThreadDrawerThread,
      cancelInteractionsForSession: cancelThreadInteractionsForSession,
      cancelConfirmDelete: cancelThreadConfirmDelete,
      cancelRename: cancelThreadRename,
      closeDrawer: closeThreadDrawer,
    },
  });
  // pendingPrefillRef(保留中のプリフィル、MF1/SF2/SF1/104.17)は
  // chat/useDraftThreadLauncher.ts へ移した(bdboard-sso1.83 第14b段)。
  // SF1: 各ドラフトキーが最後に「システムによって(ユーザー操作を経ずに)シード
  // された」ときの文言を憶えておく。プリフィル消化やマウント時シードで
  // conversationInputs へ書き込むたびに、その値をここにも記録する。textarea の
  // onChange(手入力)を経たキーは記録を更新しない(=最後に記録された値と現在値が
  // 食い違う)ので、「現在値が空でなく、かつ記録されたシード文言と一致しない」を
  // 「ユーザーが編集した」の判定に使える。
  //
  // 単純に「現在値 !== 今回新しく適用しようとしているプリフィル文言」で判定する
  // (=前回のプリフィルとの比較を省略する)と、チケットが連続して開かれた場合に
  // 「前回のチケットの(誰も編集していない)シード文言」まで「今回のプリフィルと
  // 違うから編集済み」と誤判定し、今回の新しいプリフィルを適用し損なう
  // (既存の回帰テスト「starts a fresh draft and replaces the input on each
  // ticket context token」で実際に検出された)。旧キーごとに「そのキー自身が
  // 最後に何でシードされたか」を憶えておくことで、この誤判定を避けている。
  // SFX: conversationInputs へ書き込む箇所(mount シード・startNewDraftThread の
  // プリフィル消化・handleAgentChange の引き継ぎなど)は、値をコピー/設定する
  // たびにこの記録との整合を維持する義務を負う(値だけコピーしてシード記録を
  // 移し忘れると、次回比較時に「記録が無い」→無条件で「編集済み」と誤判定する)。
  // bdboard-dpq レビュー nit: 以前は下の conversationInputs の useState
  // lazy initializer 内で draftSeedTextRef.current への書き込み(副作用)を
  // 行っていた。値そのものは各レンダーで再計算しても同じなので実害は無いが、
  // useState の初期化関数は本来副作用を持たない純粋関数であるべき、という
  // ルール上のnitだった(bdboard-ysu で解消)。useRef の初期値引数は
  // 毎レンダー評価されコミット後は破棄される(React の既知の挙動)ため、
  // ここで conversationInputs 側と同じ計算を独立に行っても、両者の間に
  // 書き込み順の依存を作らずに同じ初期値へ揃えられる。N3 と同じ理由で
  // resolveInitialProjectId を再度呼ばず selectedProjectId state をそのまま
  // 使う点も変えていない。
  // bdboard-ysu Opus レビュー N2: この計算(マウント時点の nonce 0 シード)を
  // useRef 側・useState 側それぞれで独立に書くと、将来どちらか片方だけ
  // 変更されて drift する恐れがある(SFX の「書き込み側が draftSeedTextRef の
  // 同期を所有する」不変条件のオーナーシップが暗黙のまま2箇所に分散する)。
  // 1つの const にまとめ、両方の初期値をここから作る。state 側は
  // draftSeedTextRef.current と同一オブジェクト参照を共有しない(spread で
  // コピーを渡す) — 同一参照だと、どちらかが後で自分の Record を直接 mutate
  // した場合にもう片方まで無自覚に汚染されてしまうため。
  // bdboard-sso1.83 第2段: 上のコメント群が説明する
  // initialDraftSeed/draftSeedTextRef/conversationInputs/conversationAttachments/
  // attachmentErrors の初期化ロジックと、それらの読み書きハンドラ(paste・
  // ファイル選択・削除・IME対応Enter送信・クイックコマンドのカーソル移動)は
  // web/src/components/chat/useChatDraftState.ts(+
  // useChatAttachmentIngestion.ts, chatDraftState.ts)へ抜き出した。この
  // コンポーネント側は setInput/updateConversationAttachments 等
  // (下の分割代入で受け取った各関数)経由で読み書きする。会話キーの再割り当て
  // (bdboard-c1pw の対象、startNewDraftThread / handleAgentChange /
  // handleNewThread)は chat/useDraftThreadLauncher.ts(第14b段)、コールド
  // キースペースからの移送(adoptProjectFromColdKeyspace)は
  // chat/useColdKeyspaceAdoption.ts(第14c段)にある。
  // 送信失敗時の復元(commitFailure)は
  // chat/useChatSendCommits.ts、送信時のクリア(submit)は chat/useChatSubmit.ts
  // にある(第13b段)。
  // bdboard-sso1.83 第2段(react-hooks/exhaustive-deps 対策):
  // useThreadDrawerState と同じく、フックの戻り値はオブジェクトのまま
  // 変数へ束縛せず分割代入する。`const chatDraft = useChatDraftState(...)` の
  // ままだと、下の各 useCallback が `setInput` 等プロパティ経由で
  // 参照するたびに ESLint が「chatDraft 自体が依存配列に無い」と警告する
  // (draftApplicators は個々の関数だけが参照安定で、chatDraft オブジェクト
  // 自体は毎レンダー新しいオブジェクト)。分割代入すれば各関数はただの
  // ローカル変数になり、警告なしで依存配列に個別に載せられる。
  const {
    conversationInputs,
    conversationAttachments,
    attachmentErrors,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    setInput,
    updateConversationInputs,
    updateConversationAttachments,
    setAttachmentError,
    clearAttachmentError,
    draftApplicators,
    handleImagePaste,
    handleImageFileChange,
    removeAttachment,
    applyQuickCommandPrompt,
    handleComposedEnterSubmit,
  } = useChatDraftState({
    initialInput,
    selectedProjectId,
    currentConversationKey,
    currentConversationKeyRef,
    isSending,
    inputRef,
    formRef,
  });

  return {
    selectedProjectId, setSelectedProjectId, conversations, setConversations, conversationsRef,
    historyLoadedFor, setHistoryLoadedFor, loadingHistoryFor, setLoadingHistoryFor, threadModelIds,
    setThreadModelIds, threadModelIdsRef, historyRequestIdRef, threadListRequestIdRef,
    setSelectedThreadIds, selectedThreadIdsRef, setDraftNonces, draftNoncesRef, currentSessionId,
    currentConversationKey, send, isSending, streamingReply,
    turnRecoveryGeneration, unresolvedSends, clearUnresolvedSend, clearStreamingReplyForKey,
    detachedStreamSendRef, requestAbortControllerRef, threadDrawerOpen, threadActionMenuSessionId,
    renamingSessionId, renameDraft, confirmingDeleteSessionId, showDiscoveredSessions,
    toggleThreadDrawer, closeThreadDrawer, toggleThreadActionMenu, closeThreadActionMenu,
    startThreadRename, setRenameDraft, cancelThreadRename, startThreadConfirmDelete,
    cancelThreadConfirmDelete, toggleShowDiscoveredSessions, closeShowDiscoveredSessions,
    threadError, setThreadError, ticketProjectFallbackNotice, setTicketProjectFallbackNotice,
    setThreadLists, openThreadIds, setOpenThreadIds, openThreadIdsRef, openThreads, threadById,
    displayedOpenThreads, closedThreads, hasClosedThreads, currentThreadTitle, handleCloseThread,
    selectOpenThread, reopenClosedThread, handleDeleteThread, handleRenameConfirm, handlePinToggle,
    conversationInputs, conversationAttachments, attachmentErrors, conversationInputsRef,
    conversationAttachmentsRef, draftSeedTextRef, setInput, updateConversationInputs,
    updateConversationAttachments, setAttachmentError, clearAttachmentError, draftApplicators,
    handleImagePaste, handleImageFileChange, removeAttachment, applyQuickCommandPrompt,
    handleComposedEnterSubmit,
  };
}

export type ChatPanelStores = ReturnType<typeof useChatPanelStores>;
