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
  writePersistedChatThreadState,
} from '../chatThreadStorage';
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
import { useElapsedSeconds } from './chat/useElapsedSeconds';
import { useStickToBottomScroll } from './chat/useStickToBottomScroll';
import { useConversationKey } from './chat/useConversationKey';
import { useChatThreadLists } from './chat/useChatThreadLists';
import { useChatConversationsState } from './chat/useChatConversationsState';
import { useChatHistoryLoader } from './chat/useChatHistoryLoader';
import { useTurnStatusRecovery } from './chat/useTurnStatusRecovery';
import { useDraftPayloadRegistry } from './chat/useDraftPayloadRegistry';
import { useDraftThreadLauncher } from './chat/useDraftThreadLauncher';
import { useColdKeyspaceAdoption } from './chat/useColdKeyspaceAdoption';
import { useThreadListSync } from './chat/useThreadListSync';
import { useTicketContextLaunch } from './chat/useTicketContextLaunch';

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
  // 単一の登録簿(migrateDraftPayloadKey / purgeDraftPayloadKeys)。
  // bdboard-sso1.83 第14a段で chat/useDraftPayloadRegistry.ts へ move-only で
  // 抜き出した(対象ストアの列挙・意図的な非対象・依存配列の理由はそちら参照)。
  // 返す関数の参照安定性は adoptProjectFromColdKeyspace(chat/useColdKeyspaceAdoption.ts、
  // → E6)と E9 の依存配列の
  // 前提になっている。
  const { migrateDraftPayloadKey, purgeDraftPayloadKeys } = useDraftPayloadRegistry({
    draftApplicators,
    setThreadModelIds,
  });
  // selectedThreadIdsRef は chat/useConversationKey.ts、openThreadIdsRef は
  // chat/useChatThreadLists.ts、conversationsRef は
  // chat/useChatConversationsState.ts(いずれも bdboard-sso1.83
  // 第10段・第11段)へ移した。
  // appliedTicketContextTokenRef は chat/useTicketContextLaunch.ts(第14e段)へ移した。
  // requestAbortControllerRef は chat/useChatSendState.ts (第13a段) へ移した。

  // bdboard-sso1.83 第14b段: pendingPrefillRef / pendingTicketDraftProjectRef /
  // startNewDraftThread / handleNewThread(SF5)/ handleAgentChange と、23u の
  // 自動回復での nonce 前進(advanceDraftNonceAfterSessionGone)は
  // chat/useDraftThreadLauncher.ts へ抜き出した(不変条件 N1 と各引き継ぎの
  // 説明はそちら)。effect は持たないので、元の startNewDraftThread の位置で呼ぶ。
  const {
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    startNewDraftThread,
    handleNewThread,
    handleAgentChange,
    advanceDraftNonceAfterSessionGone,
  } = useDraftThreadLauncher({
    selectedProjectId,
    currentConversationKey,
    draftNoncesRef,
    setDraftNonces,
    setSelectedThreadIds,
    historyRequestIdRef,
    setConversations,
    setHistoryLoadedFor,
    setLoadingHistoryFor,
    setThreadModelIds,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    setInput,
    updateConversationInputs,
    updateConversationAttachments,
    clearAttachmentError,
    setOpenThreadIds,
    setSelectedAgentId,
    cancelThreadConfirmDelete,
  });

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
  // ブロックする(送信ボタン disabled + chat/useChatSubmit.ts の submit 冒頭ガード)。この窓で
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

  // bdboard-sso1.83 第14c段: '' キースペース(プロジェクト未解決中のドラフト)を
  // 実プロジェクトへ移す adoptProjectFromColdKeyspace と、その2つの入口
  // (プロジェクト select の handleProjectSelectChange と、projects 到着時の
  // コールド解決 effect)を chat/useColdKeyspaceAdoption.ts へ抜き出した。
  // effect-order: E6(E5 の後、E7 より前。ticket-context effect(E9)とは
  // ticketContextToken で排他)。
  const { handleProjectSelectChange } = useColdKeyspaceAdoption({
    projects,
    initialProjectId,
    ticketContextToken,
    selectedProjectId,
    setSelectedProjectId,
    draftNoncesRef,
    setDraftNonces,
    conversationInputsRef,
    conversationAttachmentsRef,
    migrateDraftPayloadKey,
    setTicketProjectFallbackNotice,
  });

  // bdboard-sso1.83 第14d段: スレッド一覧 effect(pending の無効化と消化、
  // isExplicitDraftStillSelected、request-id ガード)を chat/useThreadListSync.ts へ
  // 抜き出した。effect-order: E7(E6 の後、E8 の turn-status 回収と E9 の
  // ticket-context effect より前)。
  useThreadListSync({
    selectedProjectId,
    setThreadError,
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    threadListRequestIdRef,
    draftNoncesRef,
    selectedThreadIdsRef,
    setThreadLists,
    setOpenThreadIds,
    setSelectedThreadIds,
    startNewDraftThread,
  });

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

  // bdboard-sso1.83 第14e段: ticket-context effect(と appliedTicketContextTokenRef)を
  // chat/useTicketContextLaunch.ts へ抜き出した。依存配列と eslint-disable は元のまま。
  // effect-order: E9(E7 のスレッド一覧 effect と E8 の turn-status 回収の後、
  // useAgentListAndModelRestore の前)。
  useTicketContextLaunch({
    ticketContextToken,
    projects,
    initialProjectId,
    initialInput,
    selectedProjectId,
    setSelectedProjectId,
    inputRef,
    ticketProjectFallbackNotice,
    setTicketProjectFallbackNotice,
    draftNoncesRef,
    conversationInputsRef,
    conversationAttachmentsRef,
    draftSeedTextRef,
    threadModelIdsRef,
    purgeDraftPayloadKeys,
    pendingPrefillRef,
    pendingTicketDraftProjectRef,
    openThreadIds,
    startNewDraftThread,
  });

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
        // bdboard-23u: ドラフト nonce の前進(startNewDraftThread を意図的に使わない
        // 理由も含む)は chat/useDraftThreadLauncher.ts に置いた(第14b段)。
        advanceDraftNonceAfterSessionGone(selectedProjectId);
      }
    },
    [
      selectedProjectId,
      setOpenThreadIds,
      setThreadLists,
      setSelectedThreadIds,
      openThreadIdsRef,
      advanceDraftNonceAfterSessionGone,
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


  // bdboard-sso1.83 第10段: openThreads/threadById/displayedOpenThreads/
  // closedThreads/hasClosedThreads は chat/useChatThreadLists.ts へ move-only で
  // 抜き出した(このコンポーネント冒頭の分割代入で受け取る)。
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
