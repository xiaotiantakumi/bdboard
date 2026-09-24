import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  fetchChatThreads,
  type ProjectDto,
  type ChatThreadDto,
  type ChatSessionMessagesDto,
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
import { useChatAgentModelState } from './chat/useChatAgentModelState';
import { useAgentFromConversationSync } from './chat/useAgentFromConversationSync';
import { useAgentListAndModelRestore } from './chat/useAgentListAndModelRestore';
import { type ChatAttachment } from './chat/attachments';
import { makeDraftKey } from './chat/draftKey';
import {
  projectSelectionHint as computeProjectSelectionHint,
  resolveInitialProjectId,
  showProjectSelect as computeShowProjectSelect,
} from './chat/projectSelection';
import {
  chatSettingsSummaryParts as computeChatSettingsSummaryParts,
  partitionThreadDrawerRows,
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
import { useChatSendState } from './chat/useChatSendState';
import { useAbortOnConversationChange } from './chat/useAbortOnConversationChange';
import { useChatSendCommits } from './chat/useChatSendCommits';
import { useChatSubmit } from './chat/useChatSubmit';
import { toChatMessages, type ChatMessage } from './chat/messages';
import {
  HANDLE_AGENT_CHANGE_DRAFT_PAYLOAD_CARRY,
  START_NEW_DRAFT_THREAD_CARRY,
  START_NEW_DRAFT_THREAD_PREFILL_CARRY,
} from './chat/draftCarryPlans';
import { useElapsedSeconds } from './chat/useElapsedSeconds';
import { useStickToBottomScroll } from './chat/useStickToBottomScroll';
import { useConversationKey } from './chat/useConversationKey';
import { useChatThreadLists } from './chat/useChatThreadLists';
import { useChatConversationsState } from './chat/useChatConversationsState';
import { useChatHistoryLoader } from './chat/useChatHistoryLoader';
import { useTurnStatusRecovery } from './chat/useTurnStatusRecovery';

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
  // handleNewThread)はこのファイルに残る。送信失敗時の復元(commitFailure)は
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
  // 未対応プラットフォームでは入力自体を塞ぐ。案内を出したうえで送信でき、
  // 送って初めて 501 に気付く、では「無効化」になっていない
  // (bdboard-70z.9, PR#115 fable レビュー)。判定が付くまでは塞がない。
  const chatUnsupported = usePlatformLimitation('chat') !== null;
  // Chat Redesign 改善点3: 「考え中…」表示に経過秒数を出す。isSending が false→true
  // に変わるたびに 0 から数え直し、1秒ごとに更新する。Date.now() は開始時点で
  // 1回だけ読んで setInterval のクロージャに閉じ込め、以後は差分計算にのみ使う。
  const sendElapsedSeconds = useElapsedSeconds(isSending);
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
  // chat/useChatSendCommits.ts の commitSuccess)の引き継ぎ選択も更新すること。
  //
  // 意図的な非対象: conversations / historyLoadedFor / streamingReply。
  // conversations / historyLoadedFor は「サーバーのセッション状態」側。
  // streamingReply は bdboard-1qoe で会話キーでスコープした Record になり形は
  // draft payload ストアと同じだが、これはクライアントが受信中のストリーム
  // バッファであり、ドラフトの「積載物」(未送信の入力/添付) ではないため対象に
  // 含めない — sendKey は selectedProjectId==='' の間は chat/useChatSubmit.ts の
  // submit が早期 return するため '' キースペースに入ることが無く、かつ
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
  // requestAbortControllerRef は chat/useChatSendState.ts (第13a段) へ移した。

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

  useAbortOnConversationChange(requestAbortControllerRef, currentConversationKey);

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

  const applyRecoveredTurn = useCallback(
    (threads: ChatThreadDto[], payload: ChatSessionMessagesDto) => {
      const currentOpen = openThreadIdsRef.current[selectedProjectId] ?? [];
      const nextOpen = [...currentOpen.filter((id) => id !== payload.sessionId), payload.sessionId];
      const currentSelected = selectedThreadIdsRef.current[selectedProjectId];
      const nextSelected = currentSelected ?? payload.sessionId;
      setThreadLists((prev) => ({ ...prev, [selectedProjectId]: threads }));
      setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextOpen }));
      setConversations((prev) => ({
        ...prev,
        [payload.sessionId]: {
          messages: toChatMessages(payload.messages),
          sessionId: payload.sessionId,
          agentId: payload.agentId,
        },
      }));
      setHistoryLoadedFor((prev) => ({ ...prev, [payload.sessionId]: true }));
      if (payload.model !== undefined && payload.model !== '') {
        setThreadModelIds((prev) => ({ ...prev, [payload.sessionId]: payload.model! }));
      }
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextSelected }));
      if (nextSelected === payload.sessionId && payload.agentId !== '') {
        setSelectedAgentId(payload.agentId);
      }
      writePersistedChatThreadState(selectedProjectId, {
        activeSessionIds: nextOpen,
        selectedSessionId: nextSelected,
      });
    },
    [
      selectedProjectId,
      openThreadIdsRef,
      selectedThreadIdsRef,
      setThreadLists,
      setOpenThreadIds,
      setConversations,
      setHistoryLoadedFor,
      setThreadModelIds,
      setSelectedThreadIds,
      setSelectedAgentId,
    ],
  );

  const { backgroundTurnStatus, backgroundTurnProjectId, resetBackgroundTurnStatus } = useTurnStatusRecovery({
    selectedProjectId,
    generation: turnRecoveryGeneration,
    detachedSendsRef: detachedStreamSendRef,
    historyRequestIdRef,
    threadListRequestIdRef,
    setLoadingHistoryFor,
    clearStreamingReplyForKey,
    clearUnresolvedSend,
    applyRecoveredTurn,
  });

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
  // 場合 chat/deliverChatSend.ts 冒頭の setStreamingReply((prev) => ({ ...prev, [sendKey]: '' }))
  // が回収中に保持していた部分テキストを即座に空文字で上書きしてしまう
  // (bdboard-v3ag のチケット本文、bdboard-3tw.166 の Opus レビュー由来)。
  //
  // detachedStreamSendRef は ref なので、その変更だけでは再レンダーが起きない
  // が、この ref への書き込み/クリアは必ず同じ同期ブロック内で別の setState
  // (setTurnRecoveryGeneration、setStreamingReply 等、上の checkTurnStatus /
  // chat/deliverChatSend.ts を参照) を伴っており、その setState が再レンダーを
  // 引き起こす。したがって useMemo 等でメモ化せず、毎レンダーでこの ref を
  // 直接読むだけで値が最新に保たれる。加えて、この値は
  // submit(chat/useChatSubmit.ts)自身の冒頭(クリック/Enter 時点)でも同様に ref を直接
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
  const { commitSuccess, commitFailure, appendTranscript } = useChatSendCommits({
    selectedProjectId,
    showModelSelect,
    effectiveModelId,
    setConversations,
    setHistoryLoadedFor,
    setThreadModelIds,
    setThreadLists,
    setOpenThreadIds,
    setSelectedThreadIds,
    conversationInputsRef,
    conversationAttachmentsRef,
    setInput,
    updateConversationAttachments,
  });

  const { handleSubmit } = useChatSubmit({
    context: {
      selectedProjectId,
      currentConversationKey,
      currentSessionId,
      conversations,
      selectedAgentId,
      selectedAgent,
      selectedAgentUnavailable,
      showModelSelect,
      effectiveModelId,
      isHistoryPending,
      currentInput,
      currentAttachments,
    },
    draft: { setInput, updateConversationAttachments, setAttachmentError },
    send,
    commitSuccess,
    commitFailure,
    appendTranscript,
    resetBackgroundTurnStatus,
    inputRef,
  });

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
