import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  acknowledgeChatTurn,
  fetchChatThreads,
  fetchChatTurnStatus,
  fetchChatSessionMessages,
  postChatMessage,
  postChatMessageStream,
  ChatStreamEndedWithoutResultError,
  type ChatMessageResponseDto,
  type ChatMessageRequest,
  type ProjectDto,
  type ChatThreadDto,
  type ChatSessionMessagesDto,
  type ChatTurnStatusDto,
  type SessionTailMessageDto,
} from '../api';
import {
  readPersistedChatThreads,
  writePersistedChatThread,
  writePersistedChatThreadState,
} from '../chatThreadStorage';
import {
  applyDraftPayloadStoreCarryPlan,
  applyTransformToAllDraftPayloadStores,
  isNeverEmpty,
  migrateKeyInRecord,
  purgeKeysInRecord,
  referenceDraftPayloadStoreCarryPlan,
  type DraftPayloadStoreTransform,
} from './conversationKeyspace';
import {
  PlatformLimitationNotice,
  usePlatformLimitation,
} from './PlatformLimitationNotice';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import {
  UI_STORAGE_KEYS,
} from '../uiPersistedState';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
} from '../hooks/useResizableSidePanel';
import type { ChatQuickCommand } from '../chatQuickCommands';
import { CHAT_AGENT_UNAVAILABLE_WARNING } from '../writeAccessMessage';
import { useChatAgentModelState } from './chat/useChatAgentModelState';
import { useAgentFromConversationSync } from './chat/useAgentFromConversationSync';
import { useAgentListAndModelRestore } from './chat/useAgentListAndModelRestore';
import {
  CHAT_IMAGE_ONLY_PROMPT,
  attachmentsToPayload,
  type ChatAttachment,
} from './chat/attachments';
import { makeDraftKey } from './chat/draftKey';
import {
  projectSelectionHint as computeProjectSelectionHint,
  resolveInitialProjectId,
  showProjectSelect as computeShowProjectSelect,
} from './chat/projectSelection';
import {
  chatSettingsSummaryParts as computeChatSettingsSummaryParts,
  partitionThreadDrawerRows,
  summarizeTitle,
} from './chat/threads';
export { formatThreadUpdatedAt } from './chat/threads';
import { ChatThreadDrawer } from './chat/ChatThreadDrawer';
import { ChatThreadDrawerOpenRow, type ThreadDrawerRowActions } from './chat/ChatThreadDrawerOpenRow';
import { ChatThreadDrawerClosedRow } from './chat/ChatThreadDrawerClosedRow';
import { ChatSettingsPanel } from './chat/ChatSettingsPanel';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatProjectBar } from './chat/ChatProjectBar';
import { ChatThreadSwitcher } from './chat/ChatThreadSwitcher';
import { ChatComposer } from './chat/ChatComposer';
import { ChatPanelHeader } from './chat/ChatPanelHeader';
import { computeSubmitDisabled, joinDescribedBy } from './chat/composerState';
import { useThreadDrawerState } from './chat/useThreadDrawerState';
import { useChatNotifications } from './chat/useChatNotifications';
import { useChatDraftState } from './chat/useChatDraftState';
import { toAssistantMessage, toChatMessages, type ChatMessage } from './chat/messages';
import {
  APPLY_CHAT_SUCCESS_DRAFT_PAYLOAD_CARRY,
  HANDLE_AGENT_CHANGE_DRAFT_PAYLOAD_CARRY,
  START_NEW_DRAFT_THREAD_CARRY,
  START_NEW_DRAFT_THREAD_PREFILL_CARRY,
} from './chat/draftCarryPlans';
import {
  CHAT_STREAM_DETACHED_FAILED_MESSAGE,
  TURN_STATUS_CLOCK_SKEW_TOLERANCE_MS,
  TURN_STATUS_POLL_RETRY_BACKOFF_MS,
  UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS,
} from './chat/turnStatusPolicy';
import { describeChatSendError } from './chat/chatSendErrors';
import { useElapsedSeconds } from './chat/useElapsedSeconds';
import { useStickToBottomScroll } from './chat/useStickToBottomScroll';
import { useConversationKey } from './chat/useConversationKey';
import { useChatThreadLists } from './chat/useChatThreadLists';
import { useChatConversationsState } from './chat/useChatConversationsState';
import { useChatHistoryLoader } from './chat/useChatHistoryLoader';

interface ChatPanelProps {
  projects: readonly ProjectDto[];
  initialProjectId?: string;
  initialInput?: string;
  ticketContextToken?: number;
  onProjectIdChange?: (projectId: string) => void;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  onClose: () => void;
}

export function ChatPanel({
  projects,
  initialProjectId,
  initialInput,
  ticketContextToken,
  onProjectIdChange,
  isTicketOnBoard,
  onOpenTicket,
  onClose,
}: ChatPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const threadDrawerRef = useRef<HTMLDivElement>(null);
  const threadDrawerCloseButtonRef = useRef<HTMLButtonElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

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
  const [isSending, setIsSending] = useState(false);
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
  // クラスタ第14段でまとめて扱う設計のため、ここでは対象外)。closeThread/
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
  // (詳細は draftSeedTextRef と startNewDraftThread 内のコメント)。これにより
  // 「窓の間にユーザーが編集した本文が消化時に無言でプリフィルへ巻き戻る」
  // 退行を防いでいる。
  //
  // マウント時点の initialInput(nonce 0 の初期シード、下の conversationInputs
  // 参照)は意図的にここへは積まない: nonce 0 は「これから採番される」ものではなく
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
  // applyChatError / submitChatMessage / handleNewThread)はこのファイルに
  // 残る。
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
  // 未対応プラットフォームでは入力自体を塞ぐ。案内を出したうえで送信でき、
  // 送って初めて 501 に気付く、では「無効化」になっていない
  // (bdboard-70z.9, PR#115 fable レビュー)。判定が付くまでは塞がない。
  const chatUnsupported = usePlatformLimitation('chat') !== null;
  // Chat Redesign 改善点3: 「考え中…」表示に経過秒数を出す。isSending が false→true
  // に変わるたびに 0 から数え直し、1秒ごとに更新する。Date.now() は開始時点で
  // 1回だけ読んで setInterval のクロージャに閉じ込め、以後は差分計算にのみ使う。
  const sendElapsedSeconds = useElapsedSeconds(isSending);
  // bdboard-1qoe: 会話キーでスコープした Record にする (単一スロットだった頃は、
  // 無関係な会話/プロジェクトへの書き込み (送信開始時の初期化・完了時のクリア) が
  // 無条件にスロット全体を上書きし、別の会話がバックグラウンドで回収待ちの間
  // 表示し続けているはずの部分テキストを巻き添えで消してしまっていた。詳細は
  // 元チケット (bdboard-v3ag PR #492 の Opus レビュー worth-considering W2) 参照。
  const [streamingReply, setStreamingReply] = useState<Record<string, string>>({});
  const [backgroundTurnStatus, setBackgroundTurnStatus] = useState<ChatTurnStatusDto>({
    state: 'idle',
  });
  const [backgroundTurnProjectId, setBackgroundTurnProjectId] = useState('');
  const [turnRecoveryGeneration, setTurnRecoveryGeneration] = useState(0);
  // 送信したのに、このクライアントでは完了を見届けられなかったスレッド
  // (返信を待たずに別スレッドへ移った等)。turn-status の回収が取りこぼした場合の
  // 安全網で、そのスレッドを表示したときに履歴を取り直す起点になる
  // (bdboard-3tw.156)。ref ではなく state なのは、まだ同じスレッドを見ている
  // うちに abort が確定した場合にも取り直しを走らせたいため。
  const [unresolvedSends, setUnresolvedSends] = useState<Record<string, true>>({});
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
  //
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
  const detachedStreamSendRef = useRef<
    Record<
      string,
      {
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
    >
  >({});
  const markUnresolvedSend = useCallback((sessionId: string | undefined) => {
    if (sessionId === undefined) return;
    setUnresolvedSends((prev) => (prev[sessionId] === true ? prev : { ...prev, [sessionId]: true }));
  }, []);
  const clearUnresolvedSend = useCallback((sessionId: string) => {
    setUnresolvedSends((prev) => {
      if (prev[sessionId] !== true) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);
  // bdboard-3tw.166: 配信停止からの回収中に表示し続けている部分テキストを、
  // その会話キーのものだけ消す。streamingReply は会話キーでスコープした Record
  // (bdboard-1qoe) なので、これはその1キーだけを delete する形になる。
  // bdboard-1qoe 以降、この「その会話キーだけ消す」性質に実際に依存している
  // 呼び出し側がある (submitChatMessage の完了/通常失敗クリア、~2888行目) —
  // 無関係な会話/プロジェクトの部分テキストを巻き添えで消さないための本番経路。
  const clearStreamingReplyForKey = useCallback((key: string) => {
    setStreamingReply((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
  // 会話(スレッド)ごとに直近確定したモデルIDをキャッシュする。サーバーから復元した
  // 値も、送信時に実際に使った値も、ここに会話キー(セッションID、または新規ドラフト
  // キー)で記録しておく。エージェント読み込みタイミング(M1)やスレッド切り替え
  // (MF3)に関わらず、「今表示している会話キーに対応する値があればそれを使う」
  // という1つの規則だけで両方のケースを解ける。
  //
  // bdboard-2n8: モデル select の onChange(手動選択、下の handleModelChange)でも
  // このキャッシュに書く。理由は2つ:
  // (a) 履歴フェッチが in-flight のときに手動選択すると、フェッチ解決時の
  //     setThreadModelIds が後勝ちで上書きしてしまう競合を防ぐ(履歴解決側は
  //     「まだ値が無いキーにだけ書く」よう変更済み)。
  // (b) 未送信ドラフトスレッド(draftKey)で選んだモデルも、そのキーのまま他の
  //     会話キーへ切り替えて戻ってきたとき(例: プロジェクトを切り替えて戻る)に
  //     保持されるようにする。104.9 ではドラフトキーをキャッシュに書く経路が
  //     単に無かっただけで、意図的な禁止ではなかった。
  //     注意(bdboard-2n8 レビュー訂正): draftKey は `new:${projectId}:${nonce}`
  //     で nonce はプロジェクト単位に保持されるため、「別プロジェクトへ切り替えて
  //     戻る」「開いているスレッドを全部閉じて選択スレッドが無くなる」「CLI
  //     セッション再開後にそのタブを閉じる」等の経路では同じ draftKey へ普通に
  //     戻ってくる(ChatPanel.test.tsx の対応するテストがこれを望ましい挙動として
  //     assert している)。つまり「古い draftKey のキャッシュエントリは二度と
  //     読まれない」という主張は誤り。クロスエージェントのモデル漏れを実際に
  //     防いでいるのはこの点ではなく、下の復元 effect が持つメンバーシップ
  //     チェック(`cached` が現在選択中エージェントの `models` に実在するときだけ
  //     適用し、無ければ既定モデルへフォールバックする)であり、エージェントを
  //     切り替える操作が draftKey の nonce を進めることでキーが自然に分離される
  //     ことも合わせて働く。
  const {
    agents,
    setAgents,
    selectedAgentId,
    setSelectedAgentId,
    selectedAgent,
    selectedAgentUnavailable,
    setSelectedModelId,
    chatModelSelections,
    showModelSelect,
    effectiveModelId,
    handleModelChange,
  } = useChatAgentModelState({
    selectedProjectId,
    currentConversationKey,
    setThreadModelIds,
  });
  const chatPanel = useResizableSidePanel(UI_STORAGE_KEYS.chatPanelWidth);
  const [isChatPanelMaximized, setIsChatPanelMaximized] = useState(false);
  // draftNoncesRef は chat/useConversationKey.ts(bdboard-sso1.83 第10段)へ移した。
  // bdboard-sso1.83 第2段: conversationInputsRef/conversationAttachmentsRef
  // (startNewDraftThread 等が stale closure を経由せず読むための「state を
  // ミラーする ref」、draftNoncesRef と同じパターン)・attachmentIdRef・
  // updateConversationAttachments は useChatDraftState.ts
  // (+ useChatAttachmentIngestion.ts)へ移した。以降は上の分割代入で受け取った
  // 各関数経由で読み書きする。
  // bdboard-c1pw / bdboard-ru4d: 会話キーで索かれる「ドラフト積載物」ストアの
  // 単一の登録簿。会話キーの再割り当て(migrateDraftPayloadKey)と、'' キースペース
  // の一括破棄(purgeDraftPayloadKeys)は、どちらも必ずこの1箇所の列挙を通る。
  // DRAFT_PAYLOAD_STORE_NAMES 型により applicators の網羅性も tsc で強制される。
  // 新しい会話キー付きストアを足すときは conversationKeyspace.ts の正本に追加し、
  // ここと3再割り当てサイト(handleAgentChange / startNewDraftThread /
  // applyChatSuccess)の引き継ぎ選択も更新すること。
  //
  // 意図的な非対象: conversations / historyLoadedFor / streamingReply。
  // conversations / historyLoadedFor は「サーバーのセッション状態」側。
  // streamingReply は bdboard-1qoe で会話キーでスコープした Record になり形は
  // draft payload ストアと同じだが、これはクライアントが受信中のストリーム
  // バッファであり、ドラフトの「積載物」(未送信の入力/添付) ではないため対象に
  // 含めない — sendKey は selectedProjectId==='' の間は submitChatMessage が
  // 早期 return するため (~2641行目) '' キースペースに入ることが無く、かつ
  // 各送信は自分の finally で自分のキーを必ず clearStreamingReplyForKey する
  // ので、ここで移送/掃除しなくても取り残されない。下の2つの呼び出しサイト
  // (コールドキースペースからの移送・'' キースペースの掃除)では元々どちらも
  // 移送されていない。ここに含めると挙動が変わる。
  const applyToDraftPayloadStores = useCallback(
    (transform: DraftPayloadStoreTransform) => {
      applyTransformToAllDraftPayloadStores(
        {
          conversationInputs: draftApplicators.conversationInputs,
          conversationAttachments: draftApplicators.conversationAttachments,
          attachmentErrors: draftApplicators.attachmentErrors,
          threadModelIds: (t) => setThreadModelIds((prev) => t(prev, isNeverEmpty)),
          draftSeedText: draftApplicators.draftSeedText,
        },
        transform,
      );
    },
    // bdboard-sso1.83 第2段(依存配列の変更理由): 以前はここに
    // updateConversationAttachments(ChatPanel ローカルの useCallback、常に
    // 参照安定)を1つ挙げるだけだった。今は4つとも draftApplicators.*
    // (useChatDraftState.ts 内で useCallback により個別にメモ化された関数)を
    // 直接使う。draftApplicators オブジェクト自体は毎レンダー新しいオブジェクト
    // リテラルなので、それを丸ごと依存配列に入れると
    // applyToDraftPayloadStores(→ migrateDraftPayloadKey/purgeDraftPayloadKeys
    // → 下のコールドウィンドウ effect の依存配列)が毎レンダー再生成され、
    // その effect が意図せず再実行されるようになってしまう。個々のプロパティ
    // (conversationInputs/conversationAttachments/attachmentErrors/
    // draftSeedText)はそれぞれ安定した参照を返すので、それらだけを列挙して
    // 元の安定性を保つ(useChatDraftState.test.tsx に参照安定性の検証テストを
    // 追加済み)。
    [
      draftApplicators.conversationInputs,
      draftApplicators.conversationAttachments,
      draftApplicators.attachmentErrors,
      draftApplicators.draftSeedText,
    ],
  );

  const migrateDraftPayloadKey = useCallback(
    (from: string, to: string) => {
      applyToDraftPayloadStores((record, isEmpty) =>
        migrateKeyInRecord(record, from, to, isEmpty),
      );
    },
    [applyToDraftPayloadStores],
  );

  const purgeDraftPayloadKeys = useCallback(
    (matches: (key: string) => boolean) => {
      applyToDraftPayloadStores((record) => purgeKeysInRecord(record, matches));
    },
    [applyToDraftPayloadStores],
  );
  // selectedThreadIdsRef は chat/useConversationKey.ts、openThreadIdsRef は
  // chat/useChatThreadLists.ts、conversationsRef は
  // chat/useChatConversationsState.ts(いずれも bdboard-sso1.83
  // 第10段・第11段)へ移した。
  const pendingTicketDraftProjectRef = useRef<string | null>(null);
  const appliedTicketContextTokenRef = useRef<number | undefined>(undefined);
  const requestAbortControllerRef = useRef<AbortController | null>(null);

  // 不変条件(N1): この関数を同一 tick 内(同期的なコールバック連鎖の中)で同じ
  // projectId に対して2回呼ぶと、両方とも同じ draftNoncesRef.current[projectId]
  // を読んでから +1 するため nonce が衝突し、2つのドラフトが同じ会話キーを
  // 奪い合う。呼び出し側(下の各 useEffect)は必ず「1回のトリガーにつき
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
    updateConversationAttachments,
    cancelThreadConfirmDelete,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    setInput,
  ]);

  const { requestClose } = useHistoryBackClose({
    panelId: 'chat',
    onClose,
  });

  // bdboard-f1c9: ドロワー開閉と相互排他(TunnelControl/TicketDetailPanel と同型)。
  // useFocusTrap の Tab 処理は defaultPrevented を見ないため、ネストした2トラップを
  // 同時 enabled にすると境界判定が競合しうる。
  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
    enabled: !threadDrawerOpen,
  });

  useFocusTrap({
    containerRef: threadDrawerRef,
    initialFocusRef: threadDrawerCloseButtonRef,
    enabled: threadDrawerOpen,
    onEscape: closeThreadDrawer,
  });

  const currentInput = conversationInputs[currentConversationKey] ?? '';
  const currentAttachments = conversationAttachments[currentConversationKey] ?? [];
  const currentAttachmentError = attachmentErrors[currentConversationKey] ?? null;
  // bdboard-pbf: 既存スレッド選択中で履歴がまだ解決していない間は送信を
  // ブロックする(送信ボタン disabled + handleSubmit 冒頭ガード)。この窓で
  // 送信すると conversations[key] が未定義のため sessionId 無しで POST され、
  // 既存スレッドの続きではなく別のサーバーセッションにフォークしてしまう。
  // loadingHistoryFor でなく historyLoadedFor を見るのは、履歴 effect が発火する
  // 前の1フレームも覆うため。履歴 fetch は成功/失敗どちらでも finally で
  // historyLoadedFor[key]=true を立てるので、永久にロックされることはない。
  const isHistoryPending =
    currentSessionId !== undefined &&
    historyLoadedFor[currentConversationKey] !== true;
  const currentMessages = conversations[currentConversationKey]?.messages ?? [];
  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  );
  // bdboard-sso1.83 第4段: showProjectSelect/projectSelectionHint の本体は
  // chat/projectSelection.ts へ移した(挙動は変えていない)。
  const showProjectSelect = computeShowProjectSelect(projects, selectedProjectId);
  const projectSelectionHint = computeProjectSelectionHint(projects, selectedProjectId);
  const projectSelectionHintId =
    projectSelectionHint === null ? null : 'chat-project-unselected-hint';
  const agentUnavailableHintId = selectedAgentUnavailable
    ? 'chat-agent-unavailable-hint'
    : null;
  const hasUnsupportedAttachments =
    currentAttachments.length > 0 && selectedAgent?.supportsImages !== true;

  useAgentFromConversationSync({
    currentSessionId,
    conversations,
    agents,
    setSelectedAgentId,
  });

  useEffect(() => {
    return () => {
      requestAbortControllerRef.current?.abort();
      requestAbortControllerRef.current = null;
    };
  }, [currentConversationKey]);

  useEffect(() => {
    if (selectedProjectId !== '') {
      onProjectIdChange?.(selectedProjectId);
    }
  }, [selectedProjectId, onProjectIdChange]);

  // bdboard-r5we: '' キースペース(プロジェクト未解決中のドラフト)から
  // 実プロジェクトのキースペースへ移す処理。従来は projects 到着時の
  // effect だけが呼んでいたが、暗黙フォールバック廃止により「ユーザーが
  // select で初めてプロジェクトを選ぶ」経路でも同じ移行が必要になったため、
  // 両者で共有する。ロジックは移動のみで変更していない。
  const adoptProjectFromColdKeyspace = useCallback(
    (resolved: string) => {
      // projects 未解決中(selectedProjectId==='')でも draftNonces[''] は進み得る:
      // 「新規スレッド」ボタン(handleNewThread、selectedProjectId!=='' でゲート
      // されていない)や、エージェント select の変更(handleAgentChange、agents の
      // ロードだけで表示されうる)がどちらも startNewDraftThread('') を呼べる。
      // ここで移行元キーを makeDraftKey('', 0) に固定すると、その間に nonce が
      // 進んでいた場合に本物のライブ入力キー(例: new::1)を見逃し、移行が
      // 空振りしてドラフトが消失/古い文言に巻き戻る。draftNoncesRef.current['']
      // (無ければ 0)を都度読んで、実際に今使われているキーを特定する。
      const coldNonce = draftNoncesRef.current[''] ?? 0;
      const staleKey = makeDraftKey('', coldNonce);
      // レビュー major-2: 「持ち込むドラフトに中身があるか」の判定は呼び出し側では
      // なくここで行う。オプション引数にすると、渡し忘れた呼び出し元(projects
      // 到着 effect)にだけドラフト消失が残る。中身があるなら、直後に再走する
      // スレッド一覧 fetch の自動選択(isExplicitDraftStillSelected が false だと
      // 既存スレッドを選んでドラフトを画面から追い出す)に負けないよう必ず bump
      // する。trim はしない — 移送側の破棄条件も `=== ''` なので、片方だけ trim
      // すると空白だけのドラフトで移送と保護がちぐはぐになる。
      const coldHasContent =
        (conversationInputsRef.current[staleKey] ?? '') !== '' ||
        (conversationAttachmentsRef.current[staleKey]?.length ?? 0) > 0;
      // bdboard-ysu(Opus レビュー SF2): coldNonce > 0 は「projects 未解決の
      // コールドウィンドウ中に、ユーザーが '' キースペースで明示的に新規ドラフト
      // 操作(新規スレッド/エージェント切替)を行った」ことを意味する。この事実を
      // resolved 側の draftNonces へ引き継がないと、下の project-sync effect の
      // 「nonce>0 かつ選択が undefined」ガード(SF1 コメント参照)が resolved
      // プロジェクトの初回 fetch 開始時点でこれを検出できず、fetch が既存
      // スレッドで解決した瞬間にこのドラフト選択が上書きされてしまう(チケットの
      // 症状そのもの、実測で確認済み)。targetNonce は「実際にこの移行後の
      // 文言が書き込まれる資格キーの nonce」でもあるため、bump は
      // targetKey を計算する前に確定させる — 後から bump すると、
      // draftKey(resolved) が指す「現在のドラフトキー」の nonce と、実際に
      // 文言を書き込んだキーの nonce がずれて、移行したはずの文言が孤児になる
      // (currentConversationKey が別の nonce を指してしまう)。'' キースペース
      // の nonce 残骸は二度と読まれないので、bump と同じ setDraftNonces 呼び出し
      // でまとめて掃除する。
      // bdboard-r5we: coldNonce が 0(ユーザーは本文を打っただけで、新規スレッド
      // /エージェント切替はしていない)でも、中身のあるドラフトを持ち込むなら
      // 同じ保護が要る。手動でプロジェクトを選んだ経路(handleProjectSelectChange)
      // と projects 到着 effect の両方が同じ判定を通る。
      let targetNonce = draftNoncesRef.current[resolved] ?? 0;
      if (coldNonce > 0 || coldHasContent) {
        targetNonce += 1;
        const bumpedTargetNonce = targetNonce;
        setDraftNonces((prev) => {
          const next: Record<string, number> = { ...prev, [resolved]: bumpedTargetNonce };
          delete next[''];
          return next;
        });
      }
      const targetKey = makeDraftKey(resolved, targetNonce);

      // レビュー minor-7 / N5・N6(bdboard-r5we): 本文・添付・添付エラー・モデル選択・
      // シード記録は同じ会話キーで持つので、必ず全部まとめて移送する。移送規則は
      // 「移送元が空なら捨てるだけ」「移送先に既に中身があれば上書きしない」
      // 「いずれにせよ移送元キーは必ず消す」で全ストア共通。ストアごとの
      // 「空」の定義(空文字を空とみなすか等)だけが違い、それは登録簿側
      // (applyToDraftPayloadStores)が各ストアに紐付けて1箇所で宣言している。
      // シード記録を引き継げなかった場合に「記録が無い」=常に「ユーザーが編集した」
      // 扱いへ倒れるのも従来どおり安全側。
      migrateDraftPayloadKey(staleKey, targetKey);

      setSelectedProjectId(resolved);
    },
    [migrateDraftPayloadKey, conversationInputsRef, conversationAttachmentsRef],
  );

  const handleProjectSelectChange = useCallback(
    (nextProjectId: string) => {
      if (nextProjectId === '') return;
      setTicketProjectFallbackNotice(null);
      if (selectedProjectId === '') {
        // 未選択状態で書きかけた本文/添付を、選んだプロジェクトのキースペースへ
        // 引き継ぐ(引き継がないと選択した瞬間にドラフトが消える)。
        adoptProjectFromColdKeyspace(nextProjectId);
        return;
      }
      setSelectedProjectId(nextProjectId);
    },
    [adoptProjectFromColdKeyspace, selectedProjectId, setTicketProjectFallbackNotice],
  );

  useEffect(() => {
    // ticketContextToken が定義されている場合は、下の ticket-context effect が
    // projects の遅延到着を処理するため、ここでは通常のチャット起動だけを扱う。
    if (ticketContextToken !== undefined) return;
    if (selectedProjectId !== '') return;
    const resolved = resolveInitialProjectId(projects, initialProjectId);
    if (resolved === '') return;

    adoptProjectFromColdKeyspace(resolved);
  }, [
    projects,
    initialProjectId,
    selectedProjectId,
    ticketContextToken,
    adoptProjectFromColdKeyspace,
  ]);

  useEffect(() => {
    if (selectedProjectId === '') return;
    // MF2/MF3: 別プロジェクト宛のまま残った pending 意図はここ(effect 本体の
    // 先頭)で無効化する。以前は cleanup 側で「この effect が担当していた
    // selectedProjectId 宛の pending だけ」を落としていたが、StrictMode の
    // 開発時ダブル実行(mount→destroy→mount)では destroy(cleanup) が
    // mount#2 の前に走ってしまい、「ユーザーがプロジェクトを離脱した」わけでも
    // ないのに mount#1 が立てた pending を消してしまっていた。mount#2 の
    // ticket-context effect は appliedTicketContextTokenRef の「適用済み」
    // ガードにより張り直さないため、結果として「チャットを開いた直後の主経路」
    // で pending が誰にも消化されず、既存スレッドが選択される回帰があった
    // (MF3、StrictMode で render を包んだ回帰テストで検出)。ここ(本体の
    // 先頭、selectedProjectId 変化のたびに必ず1回だけ実行される箇所)で
    // 「今の selectedProjectId 宛ではない pending」を無効化すれば、
    // StrictMode の疑似アンマウントでは selectedProjectId が変わらない
    // (同じプロジェクトへの mount→destroy→mount)ため誤って消されず、
    // 本当にプロジェクトが切り替わったとき(MF2 が意図した「離脱」)だけ
    // 正しく無効化される。
    if (
      pendingTicketDraftProjectRef.current !== null &&
      pendingTicketDraftProjectRef.current !== selectedProjectId
    ) {
      pendingTicketDraftProjectRef.current = null;
    }
    // pendingTicketDraftProjectRef と同じ理由での無効化。別プロジェクト宛の
    // まま残ったプリフィル文言の意図もここで一緒に無効化しないと、離脱後に
    // 同じプロジェクトへ戻って(ticketContext を介さず)手動で「新規スレッド」
    // した際、無関係になったはずの古いプリフィル文言が resurrect してしまう。
    if (
      pendingPrefillRef.current !== null &&
      pendingPrefillRef.current.projectId !== selectedProjectId
    ) {
      pendingPrefillRef.current = null;
    }
    let cancelled = false;
    const threadListRequestId = ++threadListRequestIdRef.current;
    const persisted = readPersistedChatThreads()[selectedProjectId];
    // bdboard-ysu(Opus レビュー SF1 で正確化): 「今このプロジェクトの選択が
    // ユーザーの明示操作による新規ドラフトかどうか」を、draftNonces と
    // selectedThreadIds の組み合わせで判定する。draftNonces[projectId] を
    // 実際に進める(≡ startNewDraftThread を呼ぶ)経路は2つある —
    // 「新規スレッド」ボタン(handleNewThread→startNewDraftThread)と、
    // エージェント切替(handleAgentChange、setDraftNonces を直接呼ぶ)。
    // どちらもユーザーの明示操作であり、どちらも同じタイミングで
    // selectedThreadIds[projectId] を undefined にする。
    //
    // 判定を「fetch 開始時点からの nonce の変化」ではなく「fetch 解決時点で
    // nonce>0 かつ選択が undefined のまま」という絶対条件にしているのは、
    // 後者(handleAgentChange 由来のケースや、後述のコールドウィンドウ引き継ぎ
    // 由来のケース)ではドラフトへの切り替えが必ずしも「この fetch の in-flight
    // 中」に起きるとは限らない(コールドウィンドウ経由では、プロジェクト解決
    // effect が selectedProjectId を切り替えるのと同じタイミングで nonce も
    // 引き継がれて進むため、fetch 開始のスナップショットを取った時点で
    // 既に反映済みになり、「変化した」比較では検出できない)ため。nonce>0 は
    // 「このプロジェクトで一度でも明示的な新規ドラフト操作があった」ことを
    // 意味し、selectedThreadIds[projectId]===undefined は「その後、既存
    // スレッドへ明示的に切り替えていない(まだドラフトを見ている)」ことを
    // 意味する。両方満たす間は、fetch 解決による persisted/open[0] の自動
    // 選択で上書きしてはならない — でないと fetch 解決時に既存スレッド選択
    // へ無言で巻き戻ってしまう(bdboard-dpq 最終レビューの nit、bdboard-ysu
    // で修正)。ticket-context 経由の新規ドラフト(pendingTicketDraftProjectRef
    // 分岐)は自分自身の startNewDraftThread 呼び出しがこの判定より前に
    // return するため、影響しない。
    //
    // bdboard-ysu(Opus 再レビュー最終追補): この条件は「fetch の in-flight
    // 窓の間だけ」の一時的な保護ではない、持続的な条件である。ドラフトを
    // 作った後(fetch が一度解決済みで in-flight ではない状態)にプロジェクトを
    // 離れ、スレッドを選び直さないまま同じプロジェクトへ再訪した場合、その
    // 再訪で新たに発火する fetch の解決時にも(nonce>0 かつ選択が undefined の
    // ままである限り)同じ判定が働き、自動選択は依然としてスキップされる —
    // 「ユーザーが明示的に行った選択(ここではドラフトを見ている状態)を自動で
    // 覆さない」という dpq 系の不変条件を、fetch の特定の1回の in-flight
    // だけでなく「そのドラフトを見続けている間ずっと」適用した結果であり、
    // 意図した挙動(base との差分、実測確認済み)。ページをリロードすると
    // draftNonces は state なので消え(ドラフトは意図的に永続化しない、
    // startNewDraftThread 内の「N2: ドラフトへの切り替えは意図的に
    // writePersistedChatThreadState を呼ばない」コメント参照)、次回訪問時は
    // nonce が 0 に戻るため通常どおり persisted/open[0] の復元に戻る。
    const isExplicitDraftStillSelected = () =>
      (draftNoncesRef.current[selectedProjectId] ?? 0) > 0 &&
      selectedThreadIdsRef.current[selectedProjectId] === undefined;
    void fetchChatThreads(selectedProjectId)
      .then((threads) => {
        if (cancelled || threadListRequestId !== threadListRequestIdRef.current) return;
        setThreadLists((prev) => ({ ...prev, [selectedProjectId]: threads }));
        const available = new Set(threads.map((thread) => thread.sessionId));
        const persistedOpen = (persisted?.activeSessionIds ?? []).filter((id) =>
          available.has(id),
        );
        const open = persisted !== undefined
          ? persistedOpen
          : threads.map((thread) => thread.sessionId);
        setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: open }));
        if (pendingTicketDraftProjectRef.current === selectedProjectId) {
          pendingTicketDraftProjectRef.current = null;
          startNewDraftThread(selectedProjectId);
          return;
        }
        if (isExplicitDraftStillSelected()) {
          return;
        }
        const selected = persisted?.selectedSessionId && available.has(persisted.selectedSessionId)
          ? persisted.selectedSessionId : open[0];
        setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: selected }));
      })
      .catch(() => {
        if (cancelled || threadListRequestId !== threadListRequestIdRef.current) return;
        setThreadError('スレッド一覧の取得に失敗しました。');
        const open = persisted?.activeSessionIds ?? [];
        setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: [...open] }));
        if (pendingTicketDraftProjectRef.current === selectedProjectId) {
          pendingTicketDraftProjectRef.current = null;
          startNewDraftThread(selectedProjectId);
          return;
        }
        if (isExplicitDraftStillSelected()) {
          return;
        }
        setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: persisted?.selectedSessionId ?? open[0] }));
      });
    return () => { cancelled = true; };
  }, [selectedProjectId, setThreadError]);

  useEffect(() => {
    if (selectedProjectId === '') return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    if (turnRecoveryGeneration > 0) {
      historyRequestIdRef.current += 1;
      threadListRequestIdRef.current += 1;
      setLoadingHistoryFor(null);
    }
    setBackgroundTurnProjectId(selectedProjectId);
    setBackgroundTurnStatus({ state: 'idle' });
    const recoveredSessionIds = new Set<string>();
    // bdboard-3tw.165 (Opus レビュー指摘): failedTurns はプロジェクト1件の
    // completedTurns と同じ「キュー」(bdboard-3tw.155/156) — idle (単一ロック下では
    // 「今追っている detached 送信が settle した」以外に意味を持たない) と違って、
    // ここに乗るのは「今 detachedStreamSendRef が追っている送信とは無関係の、古い/
    // 別セッションの失敗」のことがある。ACK 済みでも印を付け、ACK がサーバー側で
    // 効かず同じ1件を返し続けても tight loop しないようにする
    // (recoveredSessionIds と同じ、bdboard-3tw.156 由来のガード)。
    const drainedFailedSessionIds = new Set<string>();
    // bdboard-3tw.164: 連続失敗回数。fetchChatTurnStatus が一度でも成功したら
    // (idle/processing/completed いずれでも) 0 へ戻す — 「1回目が失敗、2回目で
    // completed」のように失敗が連続しなければ上限を消費しない。
    let consecutiveFailures = 0;
    // bdboard-96rp: UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS 用のカウンタ。
    // 「sessionId 未確定の tracked send を追っていて、sessionId 無しの failed が
    // 見えているが時刻が一致しない」という特定の状況が連続した回数だけを数える —
    // それ以外の状況 (一致した/無関係な session 付きエントリ/processing/completed/
    // idle) を1回でも挟めば 0 に戻す。定数のコメント参照。
    let unmatchedSessionlessFailedStreak = 0;

    const checkTurnStatus = async (): Promise<void> => {
      try {
        const status = await fetchChatTurnStatus(selectedProjectId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setBackgroundTurnStatus(status);
        if (status.state === 'idle') {
          // 単一ロック下では、プロジェクトにつき同時に走るターンは高々1つ。idle に
          // 落ちたのは「今追っている detached 送信が completed も failed も残さず
          // settle した」ことを意味するので、セッションIDの突き合わせは不要
          // (failed と違い、複数件が溜まる「キュー」ではない)。
          unmatchedSessionlessFailedStreak = 0;
          const detached = detachedStreamSendRef.current[selectedProjectId];
          if (detached !== undefined) {
            delete detachedStreamSendRef.current[selectedProjectId];
            // bdboard-3tw.166: 送信失敗が確定した以上、回収中ずっと表示していた
            // 部分テキストはここで消す (fail() が積むエラーメッセージと二重表示
            // させない)。
            clearStreamingReplyForKey(detached.streamingKey);
            detached.fail();
          }
          return;
        }
        if (status.state === 'failed') {
          // bdboard-3tw.165 (Opus レビュー指摘): completed 側と同じく、追っている
          // detachedStreamSendRef と sessionId が一致する場合だけ解決する。一致しない
          // 場合に idle と同じ無条件 fail() をすると、無関係な古い失敗で今追っている
          // (まだ成功するかもしれない) 送信を誤って失敗扱いにしてしまう。
          const detached = detachedStreamSendRef.current[selectedProjectId];
          // bdboard-96rp: 追っている送信自身の sessionId がまだ未確定 (新規スレッド
          // の初回送信) な場合、以前は「sessionId 無しの failed なら何でも自分の
          // ものかもしれない」として無条件に一致させていた。これは (a) 別の既に
          // sessionId が確定している送信の失敗 (status.sessionId が定義済み) まで
          // 誤って一致させてしまう、(b) この送信を追い始める *前から* キューに
          // 残っていた無関係な古い sessionId 無しエントリにも一致してしまう、という
          // 2つの誤判定を許していた。sessionId 未確定の場合は
          // status.sessionId も未確定であること・かつこの送信を追い始めた時刻
          // (detachedAt) 以降に失敗したものであることまで確認する。
          const matchesTrackedSend =
            detached !== undefined &&
            (detached.sessionId !== undefined
              ? detached.sessionId === status.sessionId
              : status.sessionId === undefined &&
                Date.parse(status.failedAt) >=
                  detached.detachedAt - TURN_STATUS_CLOCK_SKEW_TOLERANCE_MS);
          if (matchesTrackedSend) {
            unmatchedSessionlessFailedStreak = 0;
            if (status.sessionId !== undefined) {
              try {
                await acknowledgeChatTurn(selectedProjectId, status.sessionId);
              } catch {
                // ACK is best-effort; a later poll can just see the same failed turn again.
              }
              if (cancelled) return;
            }
            delete detachedStreamSendRef.current[selectedProjectId];
            // bdboard-3tw.166: idle 分岐と同じ理由 — 送信失敗が確定したので、回収中
            // 表示していた部分テキストをここで消す。
            clearStreamingReplyForKey(detached!.streamingKey);
            detached!.fail();
            return;
          }
          // 追っている送信とは無関係: 後ろに隠れているかもしれない新しいエントリ
          // (completed かもしれないし、本当に一致する failed かもしれない) を
          // 取りこぼさないよう、ACK して掃いてから聞き直す。sessionId が無い失敗
          // (エージェントがセッションを払い出す前の新規スレッド失敗) は ACK 経路が
          // 無く区別もできないので、無関係な pending 送信を誤って失敗扱いにしない
          // よう何もしない (CHAT_COMPLETED_TURNS_MAX の上限で自然に押し出されるまで
          // 残る — bdboard-3tw.165 の既知の制約、サーバー側コメント参照)。
          if (status.sessionId === undefined) {
            // bdboard-96rp (round 2 再レビューで発見されたブロッカー): ここに来るのは
            // 「sessionId 未確定の tracked send を追っているが上の時刻突き合わせで
            // 一致しなかった」場合と「そもそも sessionId 未確定の送信を追っていない」
            // 場合の両方。前者だけ、一致しない状態が
            // UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS 回続いたら、時刻の厳密な一致を
            // 諦めてこのエントリを自分自身の失敗として受け入れる (定数のコメント参照 —
            // でなければ ACK 経路が無いこの手の failed に対して無期限にブロックし得る)。
            const maybeOwnDelayedFailure =
              detached !== undefined && detached.sessionId === undefined;
            if (maybeOwnDelayedFailure) {
              unmatchedSessionlessFailedStreak += 1;
              if (
                unmatchedSessionlessFailedStreak >=
                UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS
              ) {
                unmatchedSessionlessFailedStreak = 0;
                delete detachedStreamSendRef.current[selectedProjectId];
                clearStreamingReplyForKey(detached!.streamingKey);
                detached!.fail();
                return;
              }
            } else {
              unmatchedSessionlessFailedStreak = 0;
            }
            // bdboard-v3ag Opus レビュー指摘 (blocker B1): 無条件の return だと、次の
            // トリガー (=新しい送信の配信停止) が無い限りこの effect は二度と
            // checkTurnStatus を呼ばない。無関係な failed が先頭に居座っている間、
            // 本当に追っている送信の結末を永遠に確認できなくなり、ref も送信ボタンの
            // disabled も解けない。'processing' 分岐と同じ間隔で聞き直しを続ける —
            // サーバー側は CHAT_COMPLETED_TURNS_MAX の上限に達すればこのエントリを
            // 自然に押し出すので、無限ループというより粘り強いポーリングになる。
            pollTimer = setTimeout(() => {
              void checkTurnStatus();
            }, 1_000);
            return;
          }
          unmatchedSessionlessFailedStreak = 0;
          if (drainedFailedSessionIds.has(status.sessionId)) {
            pollTimer = setTimeout(() => {
              void checkTurnStatus();
            }, 1_000);
            return;
          }
          drainedFailedSessionIds.add(status.sessionId);
          try {
            await acknowledgeChatTurn(selectedProjectId, status.sessionId);
          } catch {
            // best-effort; if the ack didn't really take effect the dedup guard above
            // still stops this from looping tightly on the exact same entry.
          }
          if (cancelled) return;
          await checkTurnStatus();
          return;
        }
        if (status.state === 'processing') {
          unmatchedSessionlessFailedStreak = 0;
          pollTimer = setTimeout(() => {
            void checkTurnStatus();
          }, 1_000);
          return;
        }
        if (status.state !== 'completed') return;
        unmatchedSessionlessFailedStreak = 0;
        // ACK が効かずサーバーが同じ1件を返し続けても、掃き出しループが
        // 回り続けないようにする (bdboard-3tw.156)。
        if (recoveredSessionIds.has(status.sessionId)) {
          // bdboard-v3ag Opus レビュー指摘 (blocker B1): drainedFailedSessionIds と
          // 同じ理由で、ここも無条件 return にすると effect が二度と
          // checkTurnStatus を呼ばなくなる。この completed エントリの背後に、
          // detachedStreamSendRef が追っている別セッションの completed/failed が
          // 隠れている場合、その解決を永遠に確認できず ref も送信ボタンの
          // disabled も解けない。'failed' 分岐の無関係エントリと同じ間隔で
          // 聞き直しを続ける (サーバー側の CHAT_COMPLETED_TURNS_MAX で自然に
          // 押し出されるまでの、粘り強いポーリング)。
          pollTimer = setTimeout(() => {
            void checkTurnStatus();
          }, 1_000);
          return;
        }
        recoveredSessionIds.add(status.sessionId);
        // bdboard-3tw.166 (Opus レビュー指摘): 表示中の部分テキストを消すのは下の
        // ハイドレーション (fetch → setConversations) が実際に成功してからにする —
        // ここで即座に消すと、2件の fetch を待つ間だけ「部分テキストも確定本文も
        // どちらも無い」空白の間が生まれてしまい、"回収したターンの本文が届いたら
        // 置き換える" という要件 (本文が届く *前* に消えない) を満たせない。
        //
        // bdboard-v3ag Opus レビュー指摘 (W1): detachedStreamSendRef 自体のクリアも
        // 同じタイミングまで遅らせる。以前は「もう完了扱いで正しい」として即座に
        // 外していたが、bdboard-v3ag のガード (hasUnresolvedProjectRecovery /
        // unresolvedProjectRecoveryAtSubmit) はこのプロジェクトのエントリの有無を
        // 「再送を止めるべき区間」の目印として使っている。ここで先にエントリだけ
        // 外すと、
        // ハイドレーション fetch が終わるまでの間だけ再送がすり抜けられるように
        // なり、その再送自身の setStreamingReply((prev) => ({ ...prev, [sendKey]: '' })) が
        // (a) このあと届く確定本文と同じ会話キーの部分テキストを本文到着前に消す、
        // (b) 新しい送信自身のライブな部分テキストまで巻き添えで消す、という
        // v3ag が塞ごうとした穴を completed 経路でだけ再現してしまう。ref のクリアと
        // clearStreamingReplyForKey を下の「本文を書き込むタイミング」に揃えることで、
        // 再送のブロックがハイドレーション完了まで一貫して効くようにする。
        const detached = detachedStreamSendRef.current[selectedProjectId];
        // bdboard-96rp (round 2 Opus レビューで W1 として一旦 'failed' 分岐と同じ
        // detachedAt 突き合わせを入れたが、round 2 の再レビューでリバートした。理由:
        // 'failed' の sessionId 無しエントリと違い、completed エントリは常に
        // sessionId が確定しており、下のハイドレーション+ACK (この関数の後半、
        // detachedMatchesThisRecovery の値に関わらず必ず実行される) で毎回
        // drain されるため、無関係な古い completed に「一致」させてしまう実害は
        // 「今追っている送信の部分テキスト表示をこの回では消し損ねる」程度に留まる
        // (次の completed/failed/idle でいずれ解決する)。
        // 一方で detachedAt 突き合わせを入れると、サーバーの completedAt がクライアント
        // 側の detachedAt (ストリーム切断を検知した時刻) より大きく後ろにずれるケース
        // (例: cloudflared トンネル越しの切断検知の遅延、bdboard-rrvr #499 が
        // 'detached' SSE イベントを消した理由と同種の「サーバーは完走しているのに
        // クライアントの切断検知が大きく遅れる」ケース) で、実際には成功して
        // ハイドレーションも完了したこの送信を、直後の 'idle' 分岐
        // (このプロジェクトの detachedStreamSendRef エントリが残ったまま次の
        // ポーリングに入り、
        // 「completed/failed を残さず idle に落ちた」と誤認される) が無条件に
        // fail() してしまう実害の方が大きいと判断した (round 2 レビューで再現済み)。
        // そのため sessionId 未確定の場合は 'failed' 分岐と違って時刻突き合わせをせず、
        // 元の無条件マッチに戻す。
        const detachedMatchesThisRecovery =
          detached !== undefined &&
          (detached.sessionId === undefined || detached.sessionId === status.sessionId);

        // A detached turn can create a session whose id was unknown when the tab closed.
        // Invalidate older history/thread-list requests before hydrating the server-owned
        // result so a late initial response cannot overwrite the recovered state.
        historyRequestIdRef.current += 1;
        setLoadingHistoryFor(null);
        const recoveryThreadRequestId = ++threadListRequestIdRef.current;
        let threads: ChatThreadDto[];
        let payload: ChatSessionMessagesDto;
        try {
          [threads, payload] = await Promise.all([
            fetchChatThreads(selectedProjectId),
            fetchChatSessionMessages(status.sessionId, selectedProjectId),
          ]);
        } catch (hydrationError) {
          // bdboard-3tw.164 (Opus レビュー指摘): ここで投げると外側の catch の
          // retry/backoff に乗るが、上の重複防止印 (recoveredSessionIds、
          // bdboard-3tw.156) を外さないと、再試行のたびに fetchChatTurnStatus は
          // 同じ completed を返すだけで「同じ1件を返し続けている」と誤認され、
          // ハイドレーションを二度と試みないまま再試行予算を空費してしまう。
          // ここでの失敗は「同じ1件を返し続けている」のではなく取得そのものの
          // 一時的な失敗なので、印を外して再試行時にもう一度ハイドレーションを
          // 試みられるようにする。
          recoveredSessionIds.delete(status.sessionId);
          throw hydrationError;
        }
        if (
          cancelled ||
          recoveryThreadRequestId !== threadListRequestIdRef.current
        ) return;
        const currentOpen = openThreadIdsRef.current[selectedProjectId] ?? [];
        const nextOpen = [
          ...currentOpen.filter((id) => id !== status.sessionId),
          status.sessionId,
        ];
        const currentSelected = selectedThreadIdsRef.current[selectedProjectId];
        const nextSelected = currentSelected ?? status.sessionId;
        setThreadLists((prev) => ({ ...prev, [selectedProjectId]: threads }));
        setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextOpen }));
        setConversations((prev) => ({
          ...prev,
          [status.sessionId]: {
            messages: toChatMessages(payload.messages),
            sessionId: payload.sessionId,
            agentId: payload.agentId,
          },
        }));
        if (detachedMatchesThisRecovery) {
          // bdboard-3tw.166 (Opus レビュー指摘): 確定本文を conversations へ書き込む
          // まさにこのタイミングで部分テキストを消す。同じ会話キーに部分テキストと
          // 確定本文が二重に出ることも、本文が届く前に両方とも消えて空白になることも
          // 防ぐ。detached!.streamingKey の detached は detachedMatchesThisRecovery が
          // true の時点で undefined でないことが確定している (上で導出した局所変数)。
          // bdboard-v3ag (W1): ref のクリアもここへ揃える (上のコメント参照) —
          // ハイドレーションが成功して初めて、このターンの detached 追跡を終えたと
          // 見なす。
          delete detachedStreamSendRef.current[selectedProjectId];
          clearStreamingReplyForKey(detached!.streamingKey);
        }
        setHistoryLoadedFor((prev) => ({ ...prev, [status.sessionId]: true }));
        if (payload.model !== undefined && payload.model !== '') {
          setThreadModelIds((prev) => ({
            ...prev,
            [status.sessionId]: payload.model!,
          }));
        }
        setSelectedThreadIds((prev) => ({
          ...prev,
          [selectedProjectId]: nextSelected,
        }));
        if (nextSelected === status.sessionId && payload.agentId !== '') {
          setSelectedAgentId(payload.agentId);
        }
        writePersistedChatThreadState(selectedProjectId, {
          activeSessionIds: nextOpen,
          selectedSessionId: nextSelected,
        });
        clearUnresolvedSend(status.sessionId);
        try {
          await acknowledgeChatTurn(selectedProjectId, status.sessionId);
        } catch {
          // ACK is best-effort; a later mount can safely hydrate the same persisted turn.
          return;
        }
        if (cancelled) return;
        // 未回収の完了は1件ずつ配られる。別スレッドの返信がまだ積まれている
        // ことがあるので、掃けるまで聞き直す (bdboard-3tw.156)。
        await checkTurnStatus();
      } catch {
        // bdboard-3tw.164: unmount / スレッド切替 / プロジェクト切替による中断は
        // 従来どおり即座に止める (再試行しない)。cancelled はこの effect の
        // cleanup でだけ立つので、ここでの失敗はネットワークエラーや一時的な
        // 5xx 等の実際の取得失敗に限られる。
        if (cancelled) return;
        consecutiveFailures += 1;
        const backoffMs =
          TURN_STATUS_POLL_RETRY_BACKOFF_MS[consecutiveFailures - 1];
        if (backoffMs === undefined) {
          // 再試行の上限に達した。sessionId が既知の送信元は既に
          // markUnresolvedSend 済みで、unresolvedSends 経由の安全網
          // (bdboard-3tw.156) がスレッド閲覧時に取りこぼしを拾えるが、
          // sessionId 未確定の新規スレッドはこの安全網の対象外 (上の定数の
          // コメント参照)。Status recovery is additive; ordinary thread/history
          // loading remains usable either way.
          console.warn(
            `chat turn-status polling gave up after ${TURN_STATUS_POLL_RETRY_BACKOFF_MS.length} consecutive failures`,
          );
          // bdboard-v3ag Opus レビュー指摘 (blocker B1): ここで何もせず return すると、
          // detachedStreamSendRef が追っていた送信の結末を永遠に確認できないまま
          // このプロジェクトのエントリが残り続ける。bdboard-v3ag はこのプロジェクトの
          // エントリが存在する間ずっと送信ボタンを disabled にするため、対処しないと
          // 利用者は
          // 二度とこのプロジェクトへ送信できなくなる(ページ再読み込み以外に回復手段が
          // 無いデッドロック)。ポーリング自体を諦める以上、idle/failed 分岐と同じ扱い
          // (ref 解放 + 保持していた部分テキストのクリア + 失敗表示) にする。
          //
          // bdboard-qfps: setBackgroundTurnStatus(status) は checkTurnStatus の
          // try 内、fetchChatTurnStatus が成功した直後の1箇所でしか呼ばれない。
          // ここ (catch, ポーリング自体を諦めた場合) はその手前で諦めているので、
          // backgroundTurnStatus は最後に成功した poll の値 (大抵 'processing') の
          // まま二度と更新されない。detachedStreamSendRef の有無に関わらず (この
          // プロジェクトの誰か/何かの 'processing' 表示を単に観測しているだけの
          // ケースも含む)、ログ上部の「返信をバックグラウンドで処理中…」バナーと
          // メッセージバブル (どちらも backgroundTurnStatus.state==='processing' 直結)
          // が凍りついたまま残ってしまう。サーバーへの疎通自体を諦めた以上、実際の
          // 状態は「不明」だが、ChatTurnStatusDto に unknown 相当の state は無いため、
          // 'idle' (=このプロジェクトについて表示すべきバックグラウンドターンは
          // 無い) にフォールバックし、凍りついたバナーを消す。
          //
          // bdboard-qfps Opus レビュー指摘 (worth-considering): 'processing' 以外
          // (例えば直前の poll が 'completed' を返していて、その後のハイドレーション
          // fetch が失敗してバックオフに入り、そのまま諦めたようなケース) まで
          // 無条件に 'idle' へ巻き戻すと、まだ意味のある「バックグラウンドの返信が
          // 完了しました。」通知を巻き添えで消してしまう。'processing' のときだけ
          // 'idle' に落とし、それ以外 (completed/failed/idle) はそのまま残す。
          setBackgroundTurnStatus((prev) =>
            prev.state === 'processing' ? { state: 'idle' } : prev,
          );
          const exhaustedDetached = detachedStreamSendRef.current[selectedProjectId];
          if (exhaustedDetached !== undefined) {
            delete detachedStreamSendRef.current[selectedProjectId];
            clearStreamingReplyForKey(exhaustedDetached.streamingKey);
            exhaustedDetached.fail();
          }
          return;
        }
        pollTimer = setTimeout(() => {
          void checkTurnStatus();
        }, backoffMs);
      }
    };

    void checkTurnStatus();
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
    };
  }, [selectedProjectId, turnRecoveryGeneration, clearUnresolvedSend, clearStreamingReplyForKey, setSelectedAgentId]);

  useEffect(() => {
    if (ticketContextToken === undefined) {
      return;
    }
    if (appliedTicketContextTokenRef.current === ticketContextToken) {
      // S3: この token は既に適用済み(targetProjectId を一度確定し、必要なら
      // フォールバックした)。ただし依存配列に `projects` が入っているため、
      // 適用済みの token のままでも projects が変化するたびにこの effect は
      // 再実行される。フォールバック発生時に出した「見つからない」notice を
      // 放置すると、その後(スキャンルート復帰・再読み込み等で)実際に
      // initialProjectId が projects に現れても notice だけが事実と乖離した
      // まま残り続ける。ここで notice を「利用可能になった」旨へ更新して
      // 解消する。selectedProjectId 自体は自動で切り替えない — ユーザーが
      // 入力中のドラフトや送信先(handleSubmit は selectedProjectId 宛)を
      // 勝手に動かさないため。切り替えは既存のプロジェクト select から
      // 手動で行える。
      if (
        ticketProjectFallbackNotice !== null &&
        initialProjectId !== undefined &&
        projects.some((project) => project.id === initialProjectId)
      ) {
        const recoveredName =
          projects.find((project) => project.id === initialProjectId)?.name ??
          initialProjectId;
        setTicketProjectFallbackNotice(
          `チケットのプロジェクト「${recoveredName}」が利用可能になりました。プロジェクト選択から切り替えられます。`,
        );
      }
      return;
    }

    const requestedProjectId = initialProjectId;
    const requestedProjectFound =
      requestedProjectId !== undefined &&
      projects.some((project) => project.id === requestedProjectId);
    const targetProjectId = requestedProjectFound
      ? requestedProjectId
      : selectedProjectId;

    // S1: projects がまだ到着していない間は資格判定ができない。ここで
    // appliedTicketContextTokenRef を進めると、projects が後から来ても
    // 二度とこの token を処理できなくなるので、未適用のまま return する。
    if (projects.length === 0) {
      return;
    }

    // bdboard-r5we: 一覧は届いているがチケットのプロジェクトが見つからず、
    // かつまだ何も選ばれていない。以前はここで projects[0] へ暗黙に倒して
    // いたが、意図しないプロジェクトへ送信される事故につながるため、未選択の
    // まま明示選択を促す。この token はこれ以上解決しようがないので適用済みに
    // する(以後は select の手動選択が対象を決める)。
    if (targetProjectId === '') {
      setTicketProjectFallbackNotice(
        `チケットのプロジェクト(id: ${requestedProjectId ?? '不明'})が見つかりません。`,
      );
      appliedTicketContextTokenRef.current = ticketContextToken;
      // レビュー minor-2: この経路だけ下の focus 処理より前に return するため、
      // 入力欄にフォーカスが当たらなかった。プロジェクトを跨がない(選択は ''
      // のまま)ので、textarea には既にコールドキースペースの文言が出ている。
      // キャレットはその現在値の末尾へ置く。
      const rafId = requestAnimationFrame(() => {
        const textarea = inputRef.current;
        if (textarea === null) {
          return;
        }
        textarea.focus();
        const caret = textarea.value.length;
        textarea.setSelectionRange(caret, caret);
      });
      return () => cancelAnimationFrame(rafId);
    }
    if (!requestedProjectFound && requestedProjectId !== undefined) {
      const fallbackName =
        projects.find((project) => project.id === targetProjectId)?.name ??
        targetProjectId;
      // S2: handleSubmit は selectedProjectId(=ここでは targetProjectId)宛に
      // 送信するため、「表示しています」だけでは受動的すぎ、チケットの
      // プロンプトが fallback 先プロジェクトのルートに対して実行されることが
      // 伝わらない。送信先が変わっている事実を明示する。
      setTicketProjectFallbackNotice(
        `チケットのプロジェクト(id: ${requestedProjectId})が見つからないため、「${fallbackName}」で開いています。この内容は「${fallbackName}」に対して送信されます。`,
      );
    } else {
      setTicketProjectFallbackNotice(null);
    }
    appliedTicketContextTokenRef.current = ticketContextToken;

    // 104.17: selectedProjectId==='' のコールドウィンドウ中(projects 未到着で
    // ticket-context の解決自体が S1 で足止めされていた間)は、マウント時シード
    // (上の conversationInputs 初期化)が '' キースペース(makeDraftKey('', N)、
    // つまり `new::N` 形式のキー)に積まれており、ユーザーがその間に書きかけた
    // 編集もそこへ乗る。targetProjectId は上の S1 早期 return を通過済みなので
    // 非空が保証されているが、selectedProjectId はこの分岐に入っている時点で
    // 定義上 '' そのもの(非空なら下の MF1 分岐は targetProjectId !==
    // selectedProjectId かどうかに関わらず通常の対象プロジェクト内で処理される)
    // なので、targetProjectId !== selectedProjectId は必ず成立し、下の MF1
    // 分岐で新しい projectId のキースペースへ切り替わる。'' キースペースは
    // 以後二度と currentConversationKey に選ばれない。104.10 の stale-key
    // migration effect は ticketContextToken !== undefined の間をこの分岐用に
    // 意図的に skip しているため、ここで引き継がないとユーザーの編集が
    // silently discard され、'' キーが conversationInputs / draftSeedTextRef の
    // 両方に孤児として残る。「システムがシードした文言のままか(未編集)」の
    // 判定は startNewDraftThread の SF1 と同じパターン(draftSeedTextRef との
    // 比較)を使う。appliedTicketContextTokenRef の上のガードにより、この
    // token に対してこのブロックはちょうど1回しか実行されない(StrictMode の
    // 二重実行でも2回目は早期 return される)ので、ここでの delete は安全。
    let ticketPrefillText = initialInput ?? '';
    // 104.17 Opus レビュー should-fix1: ticketPrefillText がユーザー自身の
    // 編集本文であり、システムのプリフィル文言と偶然一致しているだけの場合に
    // 備え、フラグで明示的に区別する。消化側(startNewDraftThread)はこれを見て
    // draftSeedTextRef への「システムシード」記録を抑止する — 記録してしまうと
    // 次にこの effect が別 token で再実行されたとき、SF1 判定が「未編集」と
    // 誤断してこのユーザー編集を破棄してしまう(probe で実証済み)。
    let ticketPrefillIsUserEdit = false;
    let ticketPrefillModelId: string | undefined;
    let ticketPrefillAttachments: readonly ChatAttachment[] | undefined;
    if (selectedProjectId === '') {
      const coldDraftKey = makeDraftKey('', draftNoncesRef.current[''] ?? 0);
      const coldValue = conversationInputsRef.current[coldDraftKey];
      if (coldValue !== undefined) {
        const coldSeedText = draftSeedTextRef.current[coldDraftKey];
        const coldValueIsEdited = coldValue !== '' && coldValue !== coldSeedText;
        if (coldValueIsEdited) {
          ticketPrefillText = coldValue;
          ticketPrefillIsUserEdit = true;
        }
      }
      const coldModelId = threadModelIdsRef.current[coldDraftKey];
      if (coldModelId !== undefined) {
        ticketPrefillModelId = coldModelId;
      }
      const coldAttachments = conversationAttachmentsRef.current[coldDraftKey];
      if (coldAttachments !== undefined && coldAttachments.length > 0) {
        ticketPrefillAttachments = [...coldAttachments];
      }
      // 104.17 Opus レビュー nit2/nit5: 引き継ぎ対象は「今ライブな nonce の
      // キー」1個だけに限らない。コールドウィンドウ中に「新規スレッド」ボタンや
      // エージェント切替で draftNonces[''] が複数回進んだ場合、古い nonce の
      // キー(例: new::0)が使われなくなった後も conversationInputs /
      // draftSeedTextRef に残り得る。104.10 の stale-key migration effect と
      // 同じ安全側パターン(値の有無に関わらず無条件で削除)に揃え、'' キー
      // スペース(`new::` prefix)にマッチする全キーをここで一括して掃除する。
      const coldKeyPattern = /^new::/;
      // 104.17 nit2/nit5: 対象は「今ライブな nonce のキー」1個に限らないので、
      // '' キースペース(`new::` prefix)に該当する全キーを、値の有無に関わらず
      // 無条件で一括削除する(104.10 の stale-key migration effect と同じ安全側
      // パターン)。対象ストアの列挙は登録簿(applyToDraftPayloadStores)に一本化
      // されているので、ここでストアを1つ書き漏らすことは構造的に起こらない。
      purgeDraftPayloadKeys((key) => coldKeyPattern.test(key));
    }

    // S2/S4-b(MF1/SF1/SF2 一括解消): プリフィルは「対象プロジェクト+文言」だけを
    // pendingPrefillRef に積む。コールドウィンドウ中の画像も同じ意図に含める。
    // 以前はここで draftNoncesRef から次の nonce を
    // 先読み予測し、その予測キーへ直接書き込んでいたが、遅延適用の窓(プロジェクト
    // を跨ぐ場合やスレッド一覧 fetch 未完了の場合、下の分岐で startNewDraftThread
    // が実際に呼ばれるのがこの effect の外・後になるケース)で他の要因により
    // nonce がずれると、予測と実際の採番が食い違って孤児エントリになり得た。
    // 実際にどの nonce のドラフトキーへ適用するかは、nonce を実際に発行する
    // 唯一の場所である startNewDraftThread 側(このファイル上部)に一本化する。
    // 104.17: text はコールドウィンドウ中の未編集の initialInput、またはその間に
    // ユーザーが編集していればその編集後の文言(ticketPrefillText)のどちらか。
    // isUserEdit は後者の場合にのみ true(should-fix1、上のコメント参照)。
    pendingPrefillRef.current = {
      projectId: targetProjectId,
      text: ticketPrefillText,
      isUserEdit: ticketPrefillIsUserEdit,
      modelId: ticketPrefillModelId,
      attachments: ticketPrefillAttachments,
    };

    // S4-b: フォーカス+キャレット移動はプリフィル意図の記録直後、分岐より前に置く。
    // 以前はプロジェクトを跨ぐ経路(MF1、直後に return する)より後ろにあり、
    // クロスプロジェクトのチケット起動だけフォーカス処理が実行されなかった。
    // N4: caretPosition は DOM(textarea.value)の現在値ではなく、この
    // effect が確定させた文言の長さから決定的に求める — rAF が実行されるまでの
    // 間に(理論上は)別の入力でテキストエリアの値が変わっていても、この起動が
    // 意図したプリフィル文言の末尾へキャレットを置くことを狙っている。104.17
    // Opus レビュー nit6: ただしプロジェクトを跨ぐ経路(MF1、コールドウィンドウ
    // からの解決を含む)では、rAF 実行時点で textarea.value はまだ空(この
    // effect が起こす setSelectedProjectId/setConversationInputs の反映は
    // 後続のレンダーを待つ)なので setSelectionRange(prefillLength,
    // prefillLength) は 0 にクランプされ、実質何もしていない。104.17 でコールド
    // ウィンドウ中の編集を引き継いだ場合に ticketPrefillText の長さを使うのも、
    // 上記と同じ理由でこの経路(常にプロジェクトを跨ぐ)では効果が無い —
    // 意図の一貫性のために initialInput ではなく実際に適用される文言の長さを
    // 使っているだけで、挙動そのものは 104.17 以前と変わらない。
    // N5: rAF ハンドルを保持し、コンポーネントがアンマウントされたら
    // cancelAnimationFrame する(useFocusTrap と同じパターン)。
    const prefillLength = ticketPrefillText.length;
    const rafId = requestAnimationFrame(() => {
      const textarea = inputRef.current;
      if (textarea === null) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(prefillLength, prefillLength);
    });

    if (targetProjectId !== selectedProjectId) {
      // MF1: プロジェクトを跨ぐ場合、setSelectedProjectId は下のスレッド一覧
      // fetch effect を(依存配列 [selectedProjectId] の変化により)再実行させる。
      // その fetch は解決時に persisted/open[0] を selectedThreadIds に書き込む
      // ため、ここで target プロジェクトが「訪問済み(openThreadIds に値がある)」
      // からといって即座に startNewDraftThread を呼んでしまうと、再実行される
      // fetch の解決が後からそれを上書きしてしまう(既存スレッドへ合流する
      // バグの再現条件)。プロジェクトを跨ぐ場合は必ず pending 経由にし、
      // 実際にドラフトへ切り替えるのは再実行後の fetch 解決(またはその
      // catch)側に一本化する。
      setSelectedProjectId(targetProjectId);
      pendingTicketDraftProjectRef.current = targetProjectId; // 再走する fetch 側で消化させる
      return () => cancelAnimationFrame(rafId);
    }

    if (openThreadIds[targetProjectId] !== undefined) {
      // プロジェクトは変わらず、かつ既にスレッド一覧を取得済み(fetch effect が
      // 再実行される見込みが無い) → 競合なく即座に新規ドラフトへ切り替えてよい。
      startNewDraftThread(targetProjectId);
    } else {
      // 初回マウント直後などでスレッド一覧 fetch がまだ完了していない。
      // fetch 完了時に上書きされないよう、pending 意図だけ記録しておく。
      pendingTicketDraftProjectRef.current = targetProjectId;
    }

    return () => cancelAnimationFrame(rafId);
    // ticketContextToken の変化(と、S1 で対象未解決だった場合の再評価、および
    // S3 で fallback notice を解消するための projects の変化)だけを起点にする
    // 意図的な依存配列。selectedProjectId / openThreadIds / initialProjectId /
    // initialInput / ticketProjectFallbackNotice はトリガー時点の最新値を
    // 都度読みたいだけであり、それら自体の変化で再実行したくない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketContextToken, projects, purgeDraftPayloadKeys]);

  useAgentListAndModelRestore({
    selectedAgent,
    selectedProjectId,
    currentConversationKey,
    threadModelIds,
    chatModelSelections,
    setAgents,
    setSelectedAgentId,
    setSelectedModelId,
  });

  const handleHistorySessionGone = useCallback(
    (sessionId: string) => {
      setOpenThreadIds((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).filter((id) => id !== sessionId),
      }));
      // bdboard-23u: handleDeleteThread(threadOps.deleteThread、bdboard-sso1.83
      // 第10段で useChatThreadLists.ts へ移設済み)の prune と対称にする —
      // でないと閉じたスレッドの再オープン経路から死亡スレッドを再選択できる。
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).filter(
          (thread) => thread.sessionId !== sessionId,
        ),
      }));
      const wasSelected = selectedThreadIdsRef.current[selectedProjectId] === sessionId;
      if (wasSelected) {
        setSelectedThreadIds((prev) =>
          prev[selectedProjectId] === sessionId
            ? { ...prev, [selectedProjectId]: undefined }
            : prev,
        );
        // bdboard-23u: handleCloseThread と同じパターンで選択クリアを
        // localStorage にも同期する。
        const nextOpenThreads = (openThreadIdsRef.current[selectedProjectId] ?? []).filter(
          (id) => id !== sessionId,
        );
        writePersistedChatThreadState(selectedProjectId, {
          activeSessionIds: nextOpenThreads,
          selectedSessionId: undefined,
        });
        // bdboard-23u: handleAgentChange と同じインラインの nonce 前進パターン
        // に揃える(pendingPrefillRef の消化などプリフィル固有の副作用を伴う
        // startNewDraftThread は、ユーザー起因でないこの自動回復では意図的に
        // 呼ばない)。
        const nextDraftNonce = (draftNoncesRef.current[selectedProjectId] ?? 0) + 1;
        setDraftNonces((prev) => ({ ...prev, [selectedProjectId]: nextDraftNonce }));
      }
    },
    [
      selectedProjectId,
      setOpenThreadIds,
      setThreadLists,
      setSelectedThreadIds,
      openThreadIdsRef,
      draftNoncesRef,
      setDraftNonces,
    ],
  );

  useChatHistoryLoader({
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
    onSessionGone: handleHistorySessionGone,
  });

  // 表示中の会話にだけ効くストリーミングテキスト。他の会話のストリームで
  // この会話をスクロールしない。streamingReply は会話キーでスコープした Record
  // (bdboard-1qoe) なので、ここは単純な参照になる。
  const activeStreamingText = streamingReply[currentConversationKey] ?? '';

  // bdboard-v3ag: 配信停止(SSE キュー上限超過等)からの turn-status 回収が
  // まだ終わっていない間、同じプロジェクトへの再送を止める。サーバーは
  // プロジェクト単位で同時に1ターンしか受け付けない (isBusy ロック) ため、
  // ここでブロックしなくても再送自体は通常 409 で弾かれるが、409 が返る
  // 前後のタイミング次第では再送がそのまま処理されてしまうことがあり、その
  // 場合 submitChatMessage 冒頭の setStreamingReply((prev) => ({ ...prev, [sendKey]: '' }))
  // が回収中に保持していた部分テキストを即座に空文字で上書きしてしまう
  // (bdboard-v3ag のチケット本文、bdboard-3tw.166 の Opus レビュー由来)。
  //
  // detachedStreamSendRef は ref なので、その変更だけでは再レンダーが起きない
  // が、この ref への書き込み/クリアは必ず同じ同期ブロック内で別の setState
  // (setTurnRecoveryGeneration、setStreamingReply 等、上の checkTurnStatus /
  // submitChatMessage を参照) を伴っており、その setState が再レンダーを
  // 引き起こす。したがって useMemo 等でメモ化せず、毎レンダーでこの ref を
  // 直接読むだけで値が最新に保たれる。加えて、この値は
  // submitChatMessage 自身の冒頭(クリック/Enter 時点)でも同様に ref を直接
  // 読んで判定しており、そちらはそもそも再レンダーに依存しない
  // (setTurnRecoveryGeneration より前に ref へ書き込まれるため、isSending が
  // false に落ちた直後の一瞬の隙間も塞げる)。
  const hasUnresolvedProjectRecovery =
    detachedStreamSendRef.current[selectedProjectId] !== undefined;

  // 「最下部に貼り付いているときだけ追う」スクロール状態を管理する。
  const { onScroll: handleMessagesScroll } = useStickToBottomScroll(
    messagesRef,
    currentConversationKey,
    currentMessages,
    isSending,
    activeStreamingText,
  );

  // bdboard-sso1.83 第2段: ingestImageFiles/handleImagePaste/
  // handleImageFileChange/removeAttachment は
  // useChatAttachmentIngestion.ts (useChatDraftState.ts 経由) へ移した。
  // 以降は handleImagePaste / handleImageFileChange /
  // removeAttachment を呼ぶ。
  const applyChatSuccess = useCallback(
    (convKey: string, sentText: string, result: ChatMessageResponseDto) => {
      // bdboard-ru4d: 会話キーの再割り当て(ドラフトキー → 確定 sessionId)だが、
      // ドラフト積載物は引き継がない(選択は APPLY_CHAT_SUCCESS_DRAFT_PAYLOAD_CARRY)。
      // 移すのは conversations(返信を追記した計算済みの値)のみ。
      referenceDraftPayloadStoreCarryPlan(APPLY_CHAT_SUCCESS_DRAFT_PAYLOAD_CARRY);
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
      setHistoryLoadedFor((prev) => ({ ...prev, [result.sessionId]: true }));
      writePersistedChatThread(selectedProjectId, {
        sessionId: result.sessionId,
        agentId: result.agentId,
      });
      if (showModelSelect && effectiveModelId !== '') {
        // 送信で実際に使われたモデルは常に確定値として勝つべきなので、ここだけは
        // 無条件で上書きする(履歴解決側の「未設定キーにだけ書く」ガードとは非対称)。
        setThreadModelIds((prev) => ({ ...prev, [result.sessionId]: effectiveModelId }));
      }
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: [
          ...(prev[selectedProjectId] ?? []).filter((thread) => thread.sessionId !== result.sessionId),
          { sessionId: result.sessionId, agentId: result.agentId, title: summarizeTitle(sentText), pinned: false, updatedAt: new Date().toISOString() },
        ],
      }));
      setOpenThreadIds((prev) => ({
        ...prev,
        [selectedProjectId]: [...(prev[selectedProjectId] ?? []).filter((id) => id !== result.sessionId), result.sessionId],
      }));
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
    [effectiveModelId, selectedProjectId, showModelSelect],
  );

  const applyChatError = useCallback(
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
      const { text: errorText, clearSession } = describeChatSendError(error);

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
      if (clearSession) writePersistedChatThread(selectedProjectId, undefined);

      // bdboard-otf(bdboard-dpq レビュー N2 フォローアップ): 送信失敗時に入力欄へ
      // 本文を復元する。送信時のクリア(handleSubmit、try の前)は失敗しても巻き戻ら
      // ないため、送信をやり損ねた本文がそのまま消えていた。復元先は convKey ——
      // 呼び出し元(handleSubmit)がクロージャで捕まえた「送信時点の会話キー」
      // (sendKey)であり、現在表示中のキー(currentConversationKey)ではない。
      // 送信中にユーザーがスレッド/プロジェクトを切り替えていた場合、現在の入力欄
      // ではなく元のキーへ復元することで、現在の入力欄を汚染しない。
      // sentText は handleSubmit が渡す trim 前の本文(SF2、Opus レビュー) —
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
      // closure なしで読むための ref ミラー、このファイル内の他の書き込み側と
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
      updateConversationAttachments,
      conversationInputsRef,
      conversationAttachmentsRef,
      setInput,
    ],
  );

  const submitChatMessage = useCallback(
    async (
      text: string,
      sentRawText: string,
      sentAttachments: readonly ChatAttachment[],
    ) => {
      if (selectedAgentUnavailable) {
        if (text !== '' || sentAttachments.length > 0) {
          const blockedAt = Date.now();
          setConversations((prev) => ({
            ...prev,
            [currentConversationKey]: {
              ...prev[currentConversationKey],
              messages: [
                ...(prev[currentConversationKey]?.messages ?? []),
                {
                  role: 'error',
                  text: CHAT_AGENT_UNAVAILABLE_WARNING,
                  at: blockedAt,
                },
              ],
            },
          }));
        }
        return;
      }
      // bdboard-v3ag: detachedStreamSendRef を ref のまま直接読む(クリック/
      // Enter 時点の最新値、hasUnresolvedProjectRecovery の定義コメント参照)。
      // isSending は配信停止直後に false へ戻るため、isSending だけのガードでは
      // 回収中の再送を防げない。
      const unresolvedProjectRecoveryAtSubmit =
        detachedStreamSendRef.current[selectedProjectId] !== undefined;
      if (
        (text === '' && sentAttachments.length === 0) ||
        isSending ||
        selectedProjectId === '' ||
        isHistoryPending ||
        unresolvedProjectRecoveryAtSubmit ||
        (sentAttachments.length > 0 && selectedAgent?.supportsImages !== true)
      ) {
        return;
      }

      const conversation = conversations[currentConversationKey];
      const agentMatches =
        selectedAgentId === '' ||
        conversation?.agentId === undefined ||
        conversation.agentId === selectedAgentId;
      // bdboard-pbf: conversations[key] が「まだ無い」(履歴 fetch がエラー等で
      // 会話が復元されていない)ときは選択中スレッドの currentSessionId へ
      // フォールバックし、sessionId 無し POST による別セッションへのフォークを防ぐ。
      // 一方、conversation が「存在するが sessionId が undefined」なのは
      // 'unknown chat session' 等の clearSession で意図的にクリアされた状態なので、
      // そのときはフォールバックせず新規セッションを開始する(従来挙動)。
      // 履歴 fetch の in-flight 中は上の isHistoryPending ガードで送信自体を
      // ブロックしているため、ここに来る「conversation 無し」は fetch 失敗後のみ。
      const sessionId = agentMatches
        ? conversation !== undefined
          ? conversation.sessionId
          : currentSessionId
        : undefined;
      const sentAt = Date.now();
      const messagePayload: ChatMessageRequest = {
        projectId: selectedProjectId,
        message: text,
      };
      if (sessionId !== undefined) messagePayload.sessionId = sessionId;
      if (selectedAgentId !== '') messagePayload.agentId = selectedAgentId;
      if (showModelSelect && effectiveModelId !== '') messagePayload.model = effectiveModelId;
      if (sentAttachments.length > 0) {
        try {
          // preview生成時に読み終えたdata URLを再利用する。送信後にFileReaderを
          // 再度待たず、POST開始前の切替でdraftを失う非同期の窓を作らない。
          messagePayload.images = attachmentsToPayload(sentAttachments);
        } catch {
          setAttachmentError(
            currentConversationKey,
            '画像を送信形式に変換できませんでした。',
          );
          return;
        }
      }

      setConversations((prev) => ({
        ...prev,
        [currentConversationKey]: {
          ...prev[currentConversationKey],
          // bdboard-pbf: 解決済みの sessionId を楽観的書き込みの時点で会話に
          // 焼き込む。これが無いと、フォールバック (conversation 未定義 →
          // currentSessionId) で送った 1 回目が transient エラー (409 等) に
          // なったとき、エラーパスが「sessionId 無しの conversation」を作って
          // しまい、リトライ時に clearSession 済みと誤分類されて sessionId 無し
          // POST でフォークする。clearSession 経路ではそもそもローカルの
          // sessionId が undefined なので、この条件付き spread は挙動を変えない。
          ...(sessionId !== undefined ? { sessionId } : {}),
          messages: [
            ...(prev[currentConversationKey]?.messages ?? []),
            {
              role: 'user',
              text,
              at: sentAt,
              ...(sentAttachments.length > 0
                ? {
                    images: sentAttachments.map(({ previewUrl, name, size }) => ({
                      previewUrl,
                      name,
                      size,
                    })),
                  }
                : {}),
            },
          ],
        },
      }));
      setInput(currentConversationKey, '');
      updateConversationAttachments((prev) => ({
        ...prev,
        [currentConversationKey]: [],
      }));
      setBackgroundTurnStatus({ state: 'idle' });
      setIsSending(true);
      const sendKey = currentConversationKey;
      // bdboard-zlzo: 新しいターンが完走したならサーバーは空いていたので、前の配信停止分の
      // 判定は捨てる (失われるのは失敗表示だけ)。送信の開始時点では捨てない —
      // 前のターンが続いている間の再送は 409 で弾かれ、判定を失うと、その後に前の
      // ターンが失敗しても何も表示されなくなる。
      const settleEarlierDetachedSend = (): void => {
        const detached = detachedStreamSendRef.current[selectedProjectId];
        if (detached !== undefined) {
          delete detachedStreamSendRef.current[selectedProjectId];
          // bdboard-3tw.166: 前の配信停止分が残していた部分テキストも一緒に消す。
          // 新しいターンが完走した以上、その古い部分テキストが後から置き換わる
          // ことはもう無い (このあと fail() も呼ばれない)。
          clearStreamingReplyForKey(detached.streamingKey);
        }
      };
      const requestController = new AbortController();
      requestAbortControllerRef.current = requestController;

      try {
        if (selectedAgent?.supportsStreaming === true) {
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
          // 単一タブの中では起こり得ない — submitChatMessage 冒頭の
          // unresolvedProjectRecoveryAtSubmit ガードが、同じプロジェクトのエントリが
          // 存在する間はこの関数の本体に到達する前に return するため。したがって
          // このローカル変数による判定は今のところ常にエントリの有無の判定と一致
          // するはず
          // だが、ガードを潜り抜ける経路が将来増えても壊れない防御としてそのまま
          // 残す(コード自体は変更しない、コメントのみ更新)。
          let detachedThisSend = false;
          try {
            const result = await postChatMessageStream(
              messagePayload,
              {
                onDelta: (delta) =>
                  setStreamingReply((prev) => ({
                    ...prev,
                    [sendKey]: (prev[sendKey] ?? '') + delta,
                  })),
              },
              requestController.signal,
            );
            applyChatSuccess(sendKey, text, result);
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
              detachedStreamSendRef.current[selectedProjectId] = {
                sessionId,
                streamingKey: sendKey,
                detachedAt: Date.now(),
                fail: () =>
                  applyChatError(
                    sendKey,
                    sentRawText,
                    sentAttachments,
                    new Error(CHAT_STREAM_DETACHED_FAILED_MESSAGE, { cause: detachedError }),
                    sentAt,
                  ),
              };
              setTurnRecoveryGeneration((generation) => generation + 1);
              markUnresolvedSend(sessionId);
            } else {
              // bdboard-w26w: まだ接続中のクライアントがインライン SSE 'error' で
              // 受け取った失敗 (この else 分岐、ApiError(502, ...) 等。プリストリーム
              // の 409/400/404 やネットワーク断もここへ来るが、それらはサーバー側で
              // recordFailedTurn されていないので以下の ACK は素通りする) も、
              // 成功時の applyChatSuccess と対称に turn-status を ACK する。サーバーは
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
              // では再現できない — 同じ理由 (submitChatMessage 冒頭のガード) で、D が
              // 未回収である間はそもそも N をこの関数の中まで進められない。この分岐
              // 自体は「ガードを回避する経路が将来増えても安全」な防御としてそのまま
              // 残している。別タブ/別クライアントから見ても、detachedStreamSendRef は
              // タブ固有の ref (コンポーネントインスタンスのメモリ上) なので、他タブの
              // D をこのタブのガードが知ることはできない — その意味では cross-tab の
              // 防御にもなっていない。したがって現状はどちらのタブ内シナリオでも
              // 到達しない、意図した防御的デッドコードだと理解した上で残している。
              const unresolvedSameSessionDetach =
                detachedStreamSendRef.current[selectedProjectId] !== undefined &&
                detachedStreamSendRef.current[selectedProjectId].sessionId === sessionId;
              if (sessionId !== undefined && !unresolvedSameSessionDetach) {
                void acknowledgeChatTurn(selectedProjectId, sessionId).catch(() => {
                  // ACK 失敗は turn-status に古い失敗エントリが残るだけ。表示は
                  // このあとの applyChatError で既にエラーとして出る。
                });
              }
              applyChatError(sendKey, sentRawText, sentAttachments, error, sentAt);
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
            const result = await postChatMessage(messagePayload, requestController.signal);
            applyChatSuccess(sendKey, text, result);
            settleEarlierDetachedSend();
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              setTurnRecoveryGeneration((generation) => generation + 1);
              markUnresolvedSend(sessionId);
            } else {
              applyChatError(sendKey, sentRawText, sentAttachments, error, sentAt);
            }
          }
        }
      } catch (error) {
        // Keep the common controller ref from surviving an unexpected adapter failure.
        requestAbortControllerRef.current = null;
        throw error;
      } finally {
        if (requestAbortControllerRef.current === requestController) {
          requestAbortControllerRef.current = null;
        }
        setIsSending(false);
        inputRef.current?.focus();
      }
    },
    [
      conversations,
      isSending,
      selectedAgentId,
      effectiveModelId,
      selectedProjectId,
      currentConversationKey,
      currentSessionId,
      isHistoryPending,
      showModelSelect,
      selectedAgent,
      selectedAgentUnavailable,
      applyChatSuccess,
      applyChatError,
      updateConversationAttachments,
      markUnresolvedSend,
      setAttachmentError,
      setInput,
    ],
  );

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmedText = currentInput.trim();
      const text =
        trimmedText === '' && currentAttachments.length > 0
          ? CHAT_IMAGE_ONLY_PROMPT
          : trimmedText;
      // bdboard-otf Opus レビュー SF2: 送信失敗時の復元(下の applyChatError 呼び出し)
      // には、この trim 済み text ではなく trim 前の本文を渡す。プリフィル文言は
      // 末尾に半角スペースを含む形式(例: `${ticketId} について: `)が本番で実在し、
      // 復元値が trim 済みだと未編集シード(draftSeedTextRef、末尾スペース込み)と
      // 一致しなくなり、SF1 の「未編集シードの復元は seed 記録を維持する」判定が
      // 壊れる。送信ペイロード自体は従来どおり trim 済み text を使う。
      await submitChatMessage(text, currentInput, currentAttachments);
    },
    [currentAttachments, currentInput, submitChatMessage],
  );

  // bdboard-3tw.133: クイックコマンドは常にプリフィル(入力欄に文言を入れて
  // フォーカスするだけ)で、即時送信はしない。誤タップでそのまま送信されて
  // しまうのを避けるため、送信するかはユーザーが送信ボタン/⌘+Enterで判断する。
  const handleQuickCommand = useCallback(
    (command: ChatQuickCommand) => {
      if (isSending || selectedProjectId === '' || isHistoryPending) {
        return;
      }
      applyQuickCommandPrompt(currentConversationKey, command.prompt);
    },
    [
      currentConversationKey,
      isHistoryPending,
      isSending,
      selectedProjectId,
      applyQuickCommandPrompt,
    ],
  );

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
      selectedProjectId,
      currentConversationKey,
      updateConversationAttachments,
      updateConversationInputs,
      draftSeedTextRef,
      setSelectedAgentId,
    ],
  );

  // bdboard-sso1.83 第10段: openThreads/threadById/displayedOpenThreads/
  // closedThreads/hasClosedThreads は chat/useChatThreadLists.ts へ move-only で
  // 抜き出した(このコンポーネント冒頭の分割代入で受け取る)。
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
  // bdboard-sso1.83 第10段: handleCloseThread は chat/useChatThreadLists.ts の
  // closeThread として move-only で抜き出した(このコンポーネント冒頭の
  // 分割代入で `closeThread: handleCloseThread` としてエイリアスして受け取って
  // いるため、以降の呼び出し箇所・コメント中の関数名は変えていない)。
  /**
   * bdboard-3tw.104.3 レビュー MF2: adopt 直後は `selectedThreadIds[projectId]` を
   * 新しいセッションIDに向け、`openThreadIds`/`threadLists` を更新し、
   * `writePersistedChatThreadState` で永続化する(104.2 のマルチスレッド化前は
   * `conversations[selectedProjectId]` に直書きしていたが、会話キーはスレッド
   * (sessionId)単位になったのでプロジェクトIDキーでは合わなくなっていた)。
   *
   * M1(レビュー再指摘): 履歴シードは `/api/sessions/:id/tail`(ライブセッション
   * インデックス由来、実測10件程度)を別途叩くのではなく、adopt レスポンスに
   * 同梱された `seedMessages`(discovery が local-only ガード配下で既に読んだ
   * トランスクリプト末尾)をそのまま使う。終了済みセッション(この機能の主用途)は
   * ライブインデックスにまず載らないため、以前の実装(`fetchSessionTail` 呼び出し)
   * はほぼ確実に 404 していた。取れる会話が無ければ簡単な説明メッセージ1行に
   * フォールバックする。
   *
   * S4(レビュー指摘): `writePersistedChatThreadState`(localStorage への書き込み)は
   * `setOpenThreadIds` の updater 関数の中では呼ばない — React の StrictMode は
   * updater を2回呼び得るため、副作用がその中にあると二重発火する。ここでは
   * 既に render スコープにある `openThreads`(このコンポーネント冒頭で
   * `openThreadIds[selectedProjectId] ?? []` から導出済み)から次の配列を計算し、
   * `setOpenThreadIds` には具体値を渡したうえで、副作用は updater の外側で呼ぶ
   * (`handleCloseThread` と同じパターン)。
   *
   * threadModelIds との関係(レビュー指摘: 意図された挙動): 下で
   * `historyLoadedFor[sessionId] = true` を先回りしてセットし、通常の
   * ChatMessageRepository 由来の履歴読み込み effect(`payload.model` から
   * `threadModelIds` を埋める側)を抑止している。そのため adopt したスレッドは
   * `threadModelIds` に何も入らず、モデルセレクトは選択中エージェントの既定モデルに
   * フォールバックする(= CLI セッション側が最後に使っていたモデルとは限らない)。
   * これはこの実装の既知の制約であり、修正対象ではない — 是正するには adopt
   * レスポンスにモデルIDも含めて `threadModelIds` を明示的に設定する追加変更が
   * 必要だが、現状スコープ外。
   *
   * S5(レビュー指摘・既知の制約): シードした会話は `conversations`(メモリ上の
   * state)にしか置かれず、`writePersistedChatThreadState` が永続化するのは
   * スレッドの開閉状態(`activeSessionIds`/`selectedSessionId`)だけでメッセージ
   * 本文は含まない。そのためページをリロードすると、スレッドタブ自体は
   * 復元されるがシードした会話内容は失われ、通常の履歴読み込み effect が
   * ChatMessageRepository(adopt 直後はまだ空)から読み直して「まだメッセージは
   * ありません」に戻る。M1 はサーバー側のデータソースの問題(ライブインデックス
   * vs トランスクリプト全体)を解決するもので、クライアント側の永続化範囲とは
   * 別の話であり、ここには畳み込めない。会話メッセージ全体をクライアント
   * ストレージへ永続化する設計変更は現状スコープ外のため、既知の制約として
   * 明文化するに留める。
   */
  const handleResumeDiscoveredSession = (
    sessionId: string,
    agentId: string,
    seedMessages: readonly SessionTailMessageDto[],
  ) => {
    const projectId = selectedProjectId;
    const fallbackNote: ChatMessage = {
      role: 'assistant',
      text: 'このCLIセッションの直近の会話をここに表示できませんでした。続きから会話できます。',
      at: Date.now(),
    };
    const seeded: ChatMessage[] =
      seedMessages.length > 0
        ? seedMessages.map((message, index) => ({
            role: message.role,
            text: message.text,
            at:
              message.timestamp !== undefined
                ? Date.parse(message.timestamp)
                : Date.now() + index,
          }))
        : [fallbackNote];

    // bdboard-2n8 レビュー should-fix: handleAgentChange と同じ理由でここでも
    // historyRequestIdRef を進める。resume したセッションIDが現在選択中の
    // 会話キーと同じ(=既にそのスレッドが開かれていて履歴フェッチが in-flight)
    // だった場合、キー自体は変わらないので通常の invalidation(currentConversationKey
    // の変化に伴う effect cleanup)が働かない。increment しないと、下でセットする
    // seeded conversation / agentId を、後から解決する古い履歴フェッチの `.then` が
    // (サーバー側の別内容で)上書きしてしまう。
    historyRequestIdRef.current += 1;
    setSelectedAgentId(agentId);
    setConversations((prev) => ({
      ...prev,
      [sessionId]: { messages: seeded, sessionId, agentId },
    }));
    // 履歴は上で seedMessages から取り込み済みなので、通常の(常に空の)
    // ChatMessageRepository 由来の自動読み込み effect は動かさない。
    setHistoryLoadedFor((prev) => ({ ...prev, [sessionId]: true }));

    const nextOpenThreads = openThreads.includes(sessionId)
      ? openThreads
      : [...openThreads, sessionId];
    setOpenThreadIds((prev) => ({ ...prev, [projectId]: nextOpenThreads }));
    writePersistedChatThreadState(projectId, {
      activeSessionIds: nextOpenThreads,
      selectedSessionId: sessionId,
    });

    setSelectedThreadIds((prev) => ({ ...prev, [projectId]: sessionId }));
    cancelThreadConfirmDelete();
    setLoadingHistoryFor((prev) => (prev === sessionId ? null : prev));

    void fetchChatThreads(projectId)
      .then((threads) => {
        setThreadLists((prev) => ({ ...prev, [projectId]: threads }));
      })
      .catch(() => {
        // 一覧の更新に失敗してもタブ表示が「(無題)」になるだけで再開自体は成立している。
      });
  };

  // bdboard-sso1.83 第10段: handleDeleteThread/handleRenameConfirm/
  // handlePinToggle/currentThreadTitle は chat/useChatThreadLists.ts の
  // deleteThread/renameThread/togglePin/currentThreadTitle として move-only で
  // 抜き出した(冒頭の分割代入でエイリアス済み。呼び出し箇所は変えていない)。
  // bdboard-sso1.83 第4段: 本体は chat/threads.ts へ移した(挙動は変えていない)。
  const chatSettingsSummaryParts = computeChatSettingsSummaryParts(
    selectedProject?.name,
    currentThreadTitle,
    selectedAgent?.label,
  );

  // Chat Redesign 1b: スレッド一覧ドロワーの行データ。ピン留め判定(displayedOpenThreads/
  // closedThreads のどちらに属していても「ピン留め」節へ寄せる mutual exclusion)は
  // chat/threads.ts の partitionThreadDrawerRows へ移した(bdboard-sso1.83 第6段。
  // 挙動は変えていない)。
  const {
    pinnedOpen: pinnedOpenSessionIds,
    unpinnedOpen: unpinnedOpenSessionIds,
    pinnedClosed: pinnedClosedThreadList,
    unpinnedClosed: unpinnedClosedThreadList,
  } = partitionThreadDrawerRows(displayedOpenThreads, closedThreads, threadById);
  const hasVisibleClosedThreads = unpinnedClosedThreadList.length > 0;

  // bdboard-sso1.83 第6段: 行の JSX 本体は ChatThreadDrawerOpenRow/
  // ChatThreadDrawerClosedRow(chat/ 配下)へ move-only で抜き出した。ここに残るのは
  // 「⋯」メニューを閉じたうえで本処理(togglePin/closeThread、いずれも
  // chat/useChatThreadLists.ts 由来)を呼ぶラッパーと、行ごとの派生値(agentLabel 等)の
  // 計算だけ。select/reopenClosed 自体(元実装の「複数ステップをまとめたハンドラ」)は
  // bdboard-sso1.83 第10段で chat/useChatThreadLists.ts の selectOpenThread/
  // reopenClosedThread へ move-only で抜き出した。actions オブジェクトは各行
  // コンポーネントへそのまま渡す(元実装と同じく、毎レンダー新しいクロージャを
  // 作るだけで安定参照化はしていない)。
  const threadDrawerRowActions: ThreadDrawerRowActions = {
    select: selectOpenThread,
    reopenClosed: reopenClosedThread,
    changeRenameDraft: setRenameDraft,
    confirmRename: (sessionId) => void handleRenameConfirm(sessionId),
    cancelRename: cancelThreadRename,
    toggleMenu: toggleThreadActionMenu,
    startRename: startThreadRename,
    togglePin: (sessionId, pinned) => {
      closeThreadActionMenu();
      void handlePinToggle(sessionId, pinned);
    },
    closeThread: (sessionId) => {
      closeThreadActionMenu();
      handleCloseThread(sessionId);
    },
    startConfirmDelete: startThreadConfirmDelete,
    deleteThread: (sessionId) => void handleDeleteThread(sessionId),
  };

  const renderThreadDrawerOpenRow = (sessionId: string) => {
    const thread = threadById.get(sessionId);
    const agentLabel = agents.find((agent) => agent.id === thread?.agentId)?.label ?? thread?.agentId;
    return (
      <ChatThreadDrawerOpenRow
        key={sessionId}
        sessionId={sessionId}
        thread={thread}
        agentLabel={agentLabel}
        isSelected={currentSessionId === sessionId}
        isRenaming={renamingSessionId === sessionId}
        renameDraft={renameDraft}
        isMenuOpen={threadActionMenuSessionId === sessionId}
        isConfirmingDelete={confirmingDeleteSessionId === sessionId}
        actions={threadDrawerRowActions}
      />
    );
  };

  const renderThreadDrawerClosedRow = (thread: ChatThreadDto) => (
    <ChatThreadDrawerClosedRow key={thread.sessionId} thread={thread} actions={threadDrawerRowActions} />
  );

  const pinnedThreadDrawerRows = [
    ...pinnedOpenSessionIds.map(renderThreadDrawerOpenRow),
    ...pinnedClosedThreadList.map(renderThreadDrawerClosedRow),
  ];
  const openThreadDrawerRows = unpinnedOpenSessionIds.map(renderThreadDrawerOpenRow);
  const closedThreadDrawerRows = unpinnedClosedThreadList.map(renderThreadDrawerClosedRow);

  return (
    <div className="overlay" onClick={requestClose} role="presentation">
      <div
        ref={panelRef}
        className={`detail-panel chat-panel resizable-side-panel${chatPanel.isResizing ? ' is-resizing' : ''}${isChatPanelMaximized ? ' is-maximized' : ''}`}
        style={{ width: isChatPanelMaximized ? '100%' : `${chatPanel.width}px` }}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-panel-title"
      >
        {!isChatPanelMaximized && (
          <SidePanelResizeHandle label="チャットパネルの幅を変更" panel={chatPanel} />
        )}
        <ChatPanelHeader
          isMaximized={isChatPanelMaximized}
          onToggleMaximize={() => setIsChatPanelMaximized((maximized) => !maximized)}
          closeButtonRef={closeButtonRef}
          onClose={requestClose}
        />

        <ChatProjectBar
          showProjectSelect={showProjectSelect}
          selectedProjectId={selectedProjectId}
          isSending={isSending}
          projectSelectionHintId={projectSelectionHintId}
          onProjectSelectChange={handleProjectSelectChange}
          projects={projects}
          selectedProjectName={selectedProject?.name}
          projectSelectionHint={projectSelectionHint}
          ticketProjectFallbackNotice={ticketProjectFallbackNotice}
        />

        <ChatThreadSwitcher
          threadDrawerOpen={threadDrawerOpen}
          onToggleDrawer={toggleThreadDrawer}
          currentThreadTitle={currentThreadTitle}
          openThreadsCount={openThreads.length}
          onNewThread={() => {
            closeThreadDrawer();
            handleNewThread();
          }}
          hasNoDisplayedOpenThreads={displayedOpenThreads.length === 0}
          hasClosedThreads={hasClosedThreads}
        />
        <ChatThreadDrawer
          open={threadDrawerOpen}
          drawerRef={threadDrawerRef}
          closeButtonRef={threadDrawerCloseButtonRef}
          onClose={closeThreadDrawer}
          hasPinnedRows={pinnedThreadDrawerRows.length > 0}
          pinnedRows={pinnedThreadDrawerRows}
          hasOpenRows={openThreadDrawerRows.length > 0}
          openRows={openThreadDrawerRows}
          hasVisibleClosedThreads={hasVisibleClosedThreads}
          closedRows={closedThreadDrawerRows}
          selectedProjectId={selectedProjectId}
          showDiscoveredSessions={showDiscoveredSessions}
          onToggleDiscoveredSessions={toggleShowDiscoveredSessions}
          isSending={isSending}
          onCloseDiscoveredSessions={closeShowDiscoveredSessions}
          onResumeDiscoveredSession={(sessionId, agentId, seedMessages) => {
            handleResumeDiscoveredSession(sessionId, agentId, seedMessages);
            closeThreadDrawer();
          }}
        />

        <ChatSettingsPanel
          summaryParts={chatSettingsSummaryParts}
          threadError={threadError}
          agents={agents}
          selectedAgentId={selectedAgentId}
          isSending={isSending}
          onAgentChange={handleAgentChange}
          selectedAgent={selectedAgent}
          showModelSelect={showModelSelect}
          effectiveModelId={effectiveModelId}
          onModelChange={handleModelChange}
        />

        {/* 送信して初めて 501 に気付く、では遅い (bdboard-70z.9)。 */}
        <PlatformLimitationNotice feature="chat" />

        <ChatMessageList
          messagesRef={messagesRef}
          onScroll={handleMessagesScroll}
          currentMessages={currentMessages}
          currentConversationKey={currentConversationKey}
          loadingHistoryFor={loadingHistoryFor}
          isSending={isSending}
          backgroundTurnProjectId={backgroundTurnProjectId}
          selectedProjectId={selectedProjectId}
          backgroundTurnStatus={backgroundTurnStatus}
          isTicketOnBoard={isTicketOnBoard}
          onOpenTicket={onOpenTicket}
          activeStreamingText={activeStreamingText}
          sendElapsedSeconds={sendElapsedSeconds}
        />

        <ChatComposer
          formRef={formRef}
          inputRef={inputRef}
          value={currentInput}
          disabled={isSending || chatUnsupported}
          onChange={(event) => {
            setInput(currentConversationKey, event.target.value);
          }}
          onPaste={handleImagePaste}
          onKeyDown={handleComposedEnterSubmit}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
          hasAttachments={currentAttachments.length > 0}
          quickCommands={{
            isSending,
            isHistoryPending,
            selectedProjectId,
            onQuickCommand: handleQuickCommand,
          }}
          notices={{
            hasUnresolvedProjectRecovery,
            isSending,
            attachments: currentAttachments,
            onRemoveAttachment: (attachmentId) => removeAttachment(currentConversationKey, attachmentId),
            attachmentError: currentAttachmentError,
            hasUnsupportedAttachments,
            selectedAgentUnavailable,
            agentUnavailableHintId,
          }}
          actions={{
            fileInputRef,
            isSending,
            chatUnsupported,
            onImageFileChange: handleImageFileChange,
            submitDisabled: computeSubmitDisabled({
              selectedProjectId,
              isSending,
              isHistoryPending,
              chatUnsupported,
              selectedAgentUnavailable,
              hasUnsupportedAttachments,
              hasUnresolvedProjectRecovery,
              currentInput,
              attachmentsCount: currentAttachments.length,
            }),
            ariaDescribedBy: joinDescribedBy([projectSelectionHintId, agentUnavailableHintId]),
          }}
        />
      </div>
    </div>
  );
}
