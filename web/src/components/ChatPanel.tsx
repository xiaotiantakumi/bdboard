import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ApiError,
  acknowledgeChatTurn,
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  deleteChatThread,
  updateChatThread,
  fetchChatSessionMessages,
  postChatMessage,
  postChatMessageStream,
  type ChatAgentDto,
  type ChatImageMimeType,
  type ChatImagePayload,
  type ChatMessageResponseDto,
  type ChatMessageRequest,
  type ProjectDto,
  type ChatThreadDto,
  type ChatTurnStatusDto,
  type SessionTailMessageDto,
} from '../api';
import {
  readPersistedChatThreads,
  writePersistedChatThread,
  writePersistedChatThreadState,
} from '../chatThreadStorage';
import { DiscoveredSessionsPanel } from './DiscoveredSessionsPanel';
import { MarkdownContent } from './MarkdownContent';
import {
  PlatformLimitationNotice,
  usePlatformLimitation,
} from './PlatformLimitationNotice';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useHistoryBackClose } from '../hooks/useHistoryBackClose';
import { usePersistedState } from '../hooks/usePersistedState';
import {
  UI_STORAGE_KEYS,
  validateChatModelSelections,
} from '../uiPersistedState';
import {
  SidePanelResizeHandle,
  useResizableSidePanel,
} from '../hooks/useResizableSidePanel';
import { CHAT_QUICK_COMMANDS, type ChatQuickCommand } from '../chatQuickCommands';
import { CHAT_BUSY_HELP, writeAccessErrorMessage } from '../writeAccessMessage';

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

type ChatMessage = {
  role: 'user' | 'assistant' | 'error';
  text: string;
  at: number;
  /** このターンで実行できなかった bd ツール呼び出しの名前(bdboard-l1t.4 MF3)。 */
  failedTools?: string[];
  /** ターンは成功したが運用者に知らせるべきエージェント側の警告(bdboard-l1t.6 N-e)。 */
  agentWarnings?: string[];
  /** 画像バイナリは履歴 API に残らないため、このマウント中だけ表示する preview。 */
  images?: ChatMessageImage[];
};

type ChatMessageImage = {
  previewUrl: string;
  name: string;
  size: number;
};

type ChatAttachment = ChatMessageImage & {
  id: string;
  file: File;
  mimeType: ChatImageMimeType;
};

// 最下部から何 px 以内なら「貼り付いている」とみなすか。ちょうど 0 で判定すると、
// 端数スクロールや sub-pixel なレイアウトで簡単に外れてしまう (bdboard-22k)。
const BOTTOM_STICK_THRESHOLD_PX = 48;

const CHAT_IMAGE_ONLY_PROMPT = '添付画像の内容を説明してください。';
const CHAT_IMAGE_MAX_COUNT = 4;
const CHAT_IMAGE_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CHAT_IMAGE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_TYPES: readonly ChatImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

function isChatImageMimeType(value: string): value is ChatImageMimeType {
  return CHAT_IMAGE_TYPES.some((mimeType) => mimeType === value);
}

function validateChatAttachments(
  existing: readonly ChatAttachment[],
  incoming: readonly File[],
): string | null {
  const unsupported = incoming.find((file) => !isChatImageMimeType(file.type));
  if (unsupported !== undefined) {
    return 'PNG・JPEG・WebP 形式の画像だけ貼り付けられます。';
  }
  if (existing.length + incoming.length > CHAT_IMAGE_MAX_COUNT) {
    return `画像は最大 ${CHAT_IMAGE_MAX_COUNT} 枚まで添付できます。`;
  }
  const oversized = incoming.find((file) => file.size > CHAT_IMAGE_MAX_FILE_BYTES);
  if (oversized !== undefined) {
    return `「${oversized.name || '名称なしの画像'}」は 5 MiB を超えています。`;
  }
  const totalBytes =
    existing.reduce((total, attachment) => total + attachment.size, 0) +
    incoming.reduce((total, file) => total + file.size, 0);
  if (totalBytes > CHAT_IMAGE_MAX_TOTAL_BYTES) {
    return '画像の合計サイズは 10 MiB 以下にしてください。';
  }
  return null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('画像を読み込めませんでした。'));
      }
    });
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('画像を読み込めませんでした。')),
    );
    reader.readAsDataURL(file);
  });
}

function attachmentsToPayload(
  attachments: readonly ChatAttachment[],
): ChatImagePayload[] {
  return attachments.map((attachment) => {
    const dataUrl = attachment.previewUrl;
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex < 0) {
      throw new Error('画像を送信形式に変換できませんでした。');
    }
    return {
      mimeType: attachment.mimeType,
      data: dataUrl.slice(commaIndex + 1),
    };
  });
}

function formatImageSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
}

// SF3: 会話キーの「新規ドラフト」書式(セッションIDを持たない未送信スレッド)を
// 1箇所に集約する。以前はこの文字列テンプレートが複数箇所(state 初期化・
// startNewDraftThread・draftKey ローカル関数・handleAgentChange)に散在していた。
function makeDraftKey(projectId: string, nonce: number): string {
  return `new:${projectId}:${nonce}`;
}

function resolveInitialProjectId(
  projects: readonly ProjectDto[],
  initialProjectId?: string,
): string {
  if (
    initialProjectId !== undefined &&
    projects.some((project) => project.id === initialProjectId)
  ) {
    return initialProjectId;
  }
  return projects[0]?.id ?? '';
}

function hasSelectableModels(agent: ChatAgentDto): boolean {
  return (agent.models?.length ?? 0) >= 2;
}

function formatAgentOptionLabel(agent: ChatAgentDto): string {
  let label = agent.label;
  // モデルを選べるエージェントでは、隣のモデルセレクトが現在値を持っている。
  // ここに descriptor 既定(例: sonnet)を出すと、Opus を選んでいるのに
  // "Claude Code (sonnet)" と表示され、2つのコントロールが矛盾する。
  if (
    !hasSelectableModels(agent) &&
    agent.model !== undefined &&
    agent.model !== ''
  ) {
    label += ` (${agent.model})`;
  }
  if (agent.experimental) {
    label += ' [experimental]';
  }
  if (agent.capability !== 'bd-only') {
    label += ` [${agent.capability}]`;
  }
  label += agent.supportsImages ? ' [画像対応]' : ' [画像非対応]';
  if (agent.availability === 'unavailable') {
    label += '（利用不可）';
  } else if (agent.availability === 'unknown') {
    label += '（認証未確認）';
  }
  return label;
}

function resolveDefaultModel(agent: ChatAgentDto): string {
  const models = agent.models ?? [];
  if (
    agent.model !== undefined &&
    models.some((entry) => entry.id === agent.model)
  ) {
    return agent.model;
  }
  return models[0]?.id ?? '';
}

function summarizeTitle(content: string): string {
  const chars = Array.from(content.trim());
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
}

// bdboard チャット改善(Chat Redesign 1b): スレッド一覧ドロワーの各行に出す
// 更新日時の短縮表示。「N分前」のような相対表記は Date.now() 依存でテストが
// 時刻に脆くなるため避け、月/日の絶対表記だけを返す決定的な実装にしている。
function formatThreadUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// スレッド一覧の並び順(bdboard-3tw.154)。更新の新しい順。
//
// ピン留めはここでは見ない。ドロワーは「ピン留め」節と「開いている/閉じた」節に
// pinned で振り分けてから描画しており、振り分けは filter なので相対順序を保つ。
// つまりピン留め優先はこの比較関数を通さずに成立していて、ここに pinned を足すと
// 表示に出ない分岐が増えるだけになる。
//
// 更新日時が読めないスレッドは 0 として最後尾に落とす。ここに来るのは
// 「開いてはいるがスレッド一覧の再取得がまだ届いていない」極短い窓
// (CLIセッションの再開直後など)だけで、次の再取得で正しい位置へ移る。
// NaN をそのまま比較に流すと比較関数が非推移的になり、並びが入力順で変わる。
function threadRecency(thread: ChatThreadDto | undefined): number {
  if (thread === undefined) return 0;
  const at = Date.parse(thread.updatedAt);
  return Number.isNaN(at) ? 0 : at;
}

function compareThreadsNewestFirst(
  a: ChatThreadDto | undefined,
  b: ChatThreadDto | undefined,
): number {
  return threadRecency(b) - threadRecency(a);
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
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const [selectedProjectId, setSelectedProjectId] = useState(() =>
    resolveInitialProjectId(projects, initialProjectId),
  );
  const [conversations, setConversations] = useState<
    Record<
      string,
      { messages: ChatMessage[]; sessionId?: string; agentId?: string }
    >
  >({});
  const [threadLists, setThreadLists] = useState<Record<string, ChatThreadDto[]>>({});
  const [openThreadIds, setOpenThreadIds] = useState<Record<string, string[]>>({});
  const [selectedThreadIds, setSelectedThreadIds] = useState<Record<string, string | undefined>>({});
  const [draftNonces, setDraftNonces] = useState<Record<string, number>>({});
  const [confirmingDeleteSessionId, setConfirmingDeleteSessionId] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Chat Redesign 1b: タブ帯を捨て、スレッド切り替えは「現在のスレッド名+件数」
  // ボタン1つ→ドロワー(縦一覧)へ集約する。threadDrawerOpen がドロワーの開閉、
  // threadActionMenuSessionId がドロワー内の各行にぶら下がる「⋯」操作メニュー
  // (リネーム/ピン留め/タブから閉じる/削除)のうち今開いているものを指す
  // (同時に1つだけ開ける設計。renamingSessionId/confirmingDeleteSessionId は
  // 既存のリネーム確定/削除確認フローをそのまま流用する)。
  const [threadDrawerOpen, setThreadDrawerOpen] = useState(false);
  const [threadActionMenuSessionId, setThreadActionMenuSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (!threadDrawerOpen) {
      setThreadActionMenuSessionId(null);
    }
  }, [threadDrawerOpen]);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [ticketProjectFallbackNotice, setTicketProjectFallbackNotice] = useState<string | null>(null);
  const [agents, setAgents] = useState<readonly ChatAgentDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [showDiscoveredSessions, setShowDiscoveredSessions] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState('');
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
  const initialDraftSeed: Record<string, string> =
    initialInput !== undefined && initialInput !== ''
      ? { [makeDraftKey(selectedProjectId, 0)]: initialInput }
      : {};
  const draftSeedTextRef = useRef<Record<string, string>>(initialDraftSeed);
  const [conversationInputs, setConversationInputs] = useState<Record<string, string>>(
    () => ({ ...initialDraftSeed }),
  );
  // File/data URL はこの React state のみに置き、localStorage や履歴 DTO へは流さない。
  // 本文と同じ会話キーを使うことで、project/thread 切替でも添付が混線しない。
  const [conversationAttachments, setConversationAttachments] = useState<
    Record<string, ChatAttachment[]>
  >({});
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({});
  const [isSending, setIsSending] = useState(false);
  // 未対応プラットフォームでは入力自体を塞ぐ。案内を出したうえで送信でき、
  // 送って初めて 501 に気付く、では「無効化」になっていない
  // (bdboard-70z.9, PR#115 fable レビュー)。判定が付くまでは塞がない。
  const chatUnsupported = usePlatformLimitation('chat') !== null;
  // Chat Redesign 改善点3: 「考え中…」表示に経過秒数を出す。isSending が false→true
  // に変わるたびに 0 から数え直し、1秒ごとに更新する。Date.now() は開始時点で
  // 1回だけ読んで setInterval のクロージャに閉じ込め、以後は差分計算にのみ使う。
  const [sendElapsedSeconds, setSendElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isSending) {
      setSendElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setSendElapsedSeconds(0);
    const timer = setInterval(() => {
      setSendElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [isSending]);
  const [streamingReply, setStreamingReply] = useState<{ key: string; text: string } | null>(null);
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
  // 取り直しが進行中のスレッド。state を使うと、印を外した瞬間に上の effect が
  // 張り直されて自分の fetch を捨てるので、ここだけは ref で持つ。
  const unresolvedRefetchRef = useRef<Set<string>>(new Set());
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
  const [historyLoadedFor, setHistoryLoadedFor] = useState<
    Record<string, true>
  >({});
  const [loadingHistoryFor, setLoadingHistoryFor] = useState<string | null>(
    null,
  );
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
  const [threadModelIds, setThreadModelIds] = useState<Record<string, string>>({});
  const [chatModelSelections, setChatModelSelections] = usePersistedState<
    Record<string, Record<string, string>>
  >(UI_STORAGE_KEYS.chatModelSelections, {}, validateChatModelSelections);
  const chatPanel = useResizableSidePanel(UI_STORAGE_KEYS.chatPanelWidth);
  const [isChatPanelMaximized, setIsChatPanelMaximized] = useState(false);
  const threadModelIdsRef = useRef(threadModelIds);
  threadModelIdsRef.current = threadModelIds;
  const historyRequestIdRef = useRef(0);
  const threadListRequestIdRef = useRef(0);
  const draftNoncesRef = useRef(draftNonces);
  draftNoncesRef.current = draftNonces;
  // SF1: startNewDraftThread (stable callback)が「切り替え直前のドラフトに
  // 何が入っていたか」を stale closure を経由せず読めるようにするための参照。
  // draftNoncesRef と同じ「state をミラーする ref」パターン。
  const conversationInputsRef = useRef(conversationInputs);
  conversationInputsRef.current = conversationInputs;
  const conversationAttachmentsRef = useRef(conversationAttachments);
  conversationAttachmentsRef.current = conversationAttachments;
  const attachmentIdRef = useRef(0);
  const updateConversationAttachments = useCallback(
    (
      updater: (
        previous: Record<string, ChatAttachment[]>,
      ) => Record<string, ChatAttachment[]>,
    ) => {
      const next = updater(conversationAttachmentsRef.current);
      conversationAttachmentsRef.current = next;
      setConversationAttachments(next);
    },
    [],
  );
  // bdboard-ysu: 下の project-sync effect が、非同期に解決する
  // fetchChatThreads().then/.catch の中から「今まさにどのスレッドが選択
  // されているか」を stale closure を経由せず読むための参照。draftNoncesRef /
  // conversationInputsRef と同じミラーパターン。
  const selectedThreadIdsRef = useRef(selectedThreadIds);
  selectedThreadIdsRef.current = selectedThreadIds;
  // bdboard-23u: 404/unknown session 自動回復の catch (このファイル内、下の
  // 履歴フェッチ effect) が、依存配列に openThreadIds を含まないまま
  // writePersistedChatThreadState 用の最新 activeSessionIds を stale closure
  // なしで読むための参照。draftNoncesRef 等と同じミラーパターン。
  const openThreadIdsRef = useRef(openThreadIds);
  openThreadIdsRef.current = openThreadIds;
  // 取り直しの適用可否を判断するときに、現在の会話の長さを deps を増やさずに
  // 読むための参照 (bdboard-3tw.156)。
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const pendingTicketDraftProjectRef = useRef<string | null>(null);
  const appliedTicketContextTokenRef = useRef<number | undefined>(undefined);
  const requestAbortControllerRef = useRef<AbortController | null>(null);

  // 不変条件(N1): この関数を同一 tick 内(同期的なコールバック連鎖の中)で同じ
  // projectId に対して2回呼ぶと、両方とも同じ draftNoncesRef.current[projectId]
  // を読んでから +1 するため nonce が衝突し、2つのドラフトが同じ会話キーを
  // 奪い合う。呼び出し側(下の各 useEffect)は必ず「1回のトリガーにつき
  // startNewDraftThread は高々1回」を守ること。
  const startNewDraftThread = useCallback((projectId: string) => {
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
    setConfirmingDeleteSessionId(null);
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
      if (textToApply === prefillText && !prefillIsUserEdit) {
        draftSeedTextRef.current[nextDraftKey] = prefillText;
      } else {
        delete draftSeedTextRef.current[nextDraftKey];
      }
      setConversationInputs((prev) => ({ ...prev, [nextDraftKey]: textToApply }));
      if (prefillModelId !== undefined) {
        setThreadModelIds((prev) => ({ ...prev, [nextDraftKey]: prefillModelId }));
      }
      const liveAttachments = conversationAttachmentsRef.current[previousDraftKey] ?? [];
      const attachmentsToCarry = liveAttachments.length > 0
        ? liveAttachments
        : prefillAttachments;
      if (attachmentsToCarry.length > 0) {
        updateConversationAttachments((prev) => ({
          ...Object.fromEntries(
            Object.entries(prev).filter(([key]) => key !== previousDraftKey),
          ),
          [nextDraftKey]: [...attachmentsToCarry],
        }));
      }
    }
    // N2: ドラフトへの切り替えは意図的に writePersistedChatThreadState を呼ばない。
    // ドラフトはセッションIDを持たない(非永続)ので、localStorage の
    // selectedSessionId をここで書き換える対象が無い — 既存の永続化済み選択は
    // そのまま(次回訪問時にまた同じ既存スレッドへ戻れるように)残す。
  }, [updateConversationAttachments]);

  const { requestClose } = useHistoryBackClose({
    panelId: 'chat',
    onClose,
  });

  useFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: requestClose,
  });

  const currentSessionId = selectedThreadIds[selectedProjectId];
  const draftKey = (projectId: string) => makeDraftKey(projectId, draftNonces[projectId] ?? 0);
  const currentConversationKey = currentSessionId ?? draftKey(selectedProjectId);
  const currentConversationKeyRef = useRef(currentConversationKey);
  currentConversationKeyRef.current = currentConversationKey;
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
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const hasUnsupportedAttachments =
    currentAttachments.length > 0 && selectedAgent?.supportsImages !== true;

  useEffect(() => {
    if (currentSessionId === undefined) return;
    const conversationAgentId = conversations[currentSessionId]?.agentId;
    if (
      conversationAgentId !== undefined &&
      conversationAgentId !== '' &&
      agents.some((agent) => agent.id === conversationAgentId)
    ) {
      setSelectedAgentId(conversationAgentId);
    }
  }, [currentSessionId, conversations, agents]);

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

  useEffect(() => {
    // ticketContextToken が定義されている場合は、下の ticket-context effect が
    // projects の遅延到着を処理するため、ここでは通常のチャット起動だけを扱う。
    if (ticketContextToken !== undefined) return;
    if (selectedProjectId !== '') return;
    const resolved = resolveInitialProjectId(projects, initialProjectId);
    if (resolved === '') return;

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
    let targetNonce = draftNoncesRef.current[resolved] ?? 0;
    if (coldNonce > 0) {
      targetNonce += 1;
      const bumpedTargetNonce = targetNonce;
      setDraftNonces((prev) => {
        const next: Record<string, number> = { ...prev, [resolved]: bumpedTargetNonce };
        delete next[''];
        return next;
      });
    }
    const targetKey = makeDraftKey(resolved, targetNonce);

    setConversationInputs((prev) => {
      if (!(staleKey in prev)) return prev;
      const { [staleKey]: staleValue, ...rest } = prev;
      if (staleValue === undefined || staleValue === '') return rest;
      if (rest[targetKey] !== undefined && rest[targetKey] !== '') return rest;
      return { ...rest, [targetKey]: staleValue };
    });
    updateConversationAttachments((prev) => {
      if (!(staleKey in prev)) return prev;
      const { [staleKey]: staleAttachments, ...rest } = prev;
      if (staleAttachments === undefined || staleAttachments.length === 0) return rest;
      if ((rest[targetKey]?.length ?? 0) > 0) return rest;
      return { ...rest, [targetKey]: staleAttachments };
    });
    setAttachmentErrors((prev) => {
      if (!(staleKey in prev)) return prev;
      const { [staleKey]: staleError, ...rest } = prev;
      if (staleError === undefined || rest[targetKey] !== undefined) return rest;
      return { ...rest, [targetKey]: staleError };
    });
    // N5/N6: 現行の App.tsx 配線では initialInput は ticketContextToken と
    // 常に連動して渡される(実質「両方あるか両方無いか」)ため、この effect
    // (ticketContextToken===undefined 限定)が実際に到達するケースでは
    // initialInput は常に undefined であり、draftSeedTextRef に '' キーの
    // シード記録が存在すること自体が現状のプロダクションコードパスでは
    // 到達不能。それでも安全側として、上の conversationInputs 側の
    // early-return(staleKey が無ければ何もしない)とは非対称に、ここは
    // 無条件で実行している: 万一 staleKey にシード記録だけが残っていた場合、
    // それを引き継がず delete だけすると「記録が無い」→次回比較で
    // 無条件に「ユーザーが編集した」扱いになり、常に安全側(=誤ってプリフィル
    // 扱いにされるより、誤って編集済み扱いにされる方が実害が小さい)に倒れる。
    // updater 内で setConversationInputs のような setState 経由にしていない
    // のは、draftSeedTextRef が ref(state ではない)であり、更新の純粋性を
    // React の setState updater に持ち込む必要が無いため。
    if (staleKey in draftSeedTextRef.current) {
      if (!(targetKey in draftSeedTextRef.current)) {
        draftSeedTextRef.current[targetKey] = draftSeedTextRef.current[staleKey];
      }
      delete draftSeedTextRef.current[staleKey];
    }

    setSelectedProjectId(resolved);
  }, [projects, initialProjectId, selectedProjectId, ticketContextToken, updateConversationAttachments]);

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
  }, [selectedProjectId]);

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

    const checkTurnStatus = async (): Promise<void> => {
      try {
        const status = await fetchChatTurnStatus(selectedProjectId);
        if (cancelled) return;
        setBackgroundTurnStatus(status);
        if (status.state === 'processing') {
          pollTimer = setTimeout(() => {
            void checkTurnStatus();
          }, 1_000);
          return;
        }
        if (status.state !== 'completed') return;
        // ACK が効かずサーバーが同じ1件を返し続けても、掃き出しループが
        // 回り続けないようにする (bdboard-3tw.156)。
        if (recoveredSessionIds.has(status.sessionId)) return;
        recoveredSessionIds.add(status.sessionId);

        // A detached turn can create a session whose id was unknown when the tab closed.
        // Invalidate older history/thread-list requests before hydrating the server-owned
        // result so a late initial response cannot overwrite the recovered state.
        historyRequestIdRef.current += 1;
        setLoadingHistoryFor(null);
        const recoveryThreadRequestId = ++threadListRequestIdRef.current;
        const [threads, payload] = await Promise.all([
          fetchChatThreads(selectedProjectId),
          fetchChatSessionMessages(status.sessionId, selectedProjectId),
        ]);
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
            messages: payload.messages.map((message) => ({
              role: message.role,
              text: message.content,
              at: Date.parse(message.createdAt),
              ...(message.failedTools !== undefined && message.failedTools.length > 0
                ? { failedTools: message.failedTools }
                : {}),
              ...(message.agentWarnings !== undefined && message.agentWarnings.length > 0
                ? { agentWarnings: message.agentWarnings }
                : {}),
            })),
            sessionId: payload.sessionId,
            agentId: payload.agentId,
          },
        }));
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
        // Status recovery is additive. Ordinary thread/history loading remains usable.
      }
    };

    void checkTurnStatus();
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
    };
  }, [selectedProjectId, turnRecoveryGeneration, clearUnresolvedSend]);

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
      : selectedProjectId !== ''
        ? selectedProjectId
        : (projects[0]?.id ?? '');

    if (targetProjectId === '') {
      // S1: projects がまだ読み込まれておらず(または initialProjectId が
      // 存在するプロジェクト一覧の中に無く) 対象を解決できない。ここで
      // appliedTicketContextTokenRef を進めてしまうと、下の deps に `projects`
      // を含めていても「トークンはもう適用済み」のガードで即 return するだけに
      // なり、projects が後から読み込まれても二度とこの token を処理できなくなる
      // (永久に何も起きない)。target を解決できるまでは「未適用」のままにして
      // おき、`projects` が変わって effect が再実行されたときに再度資格判定できる
      // ようにする。
      return;
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
      setConversationInputs((prev) => {
        const staleKeys = Object.keys(prev).filter((key) => coldKeyPattern.test(key));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        for (const key of staleKeys) {
          delete next[key];
        }
        return next;
      });
      for (const key of Object.keys(draftSeedTextRef.current)) {
        if (coldKeyPattern.test(key)) {
          delete draftSeedTextRef.current[key];
        }
      }
      setThreadModelIds((prev) => {
        const staleKeys = Object.keys(prev).filter((key) => coldKeyPattern.test(key));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        for (const key of staleKeys) {
          delete next[key];
        }
        return next;
      });
      updateConversationAttachments((prev) => {
        const staleKeys = Object.keys(prev).filter((key) => coldKeyPattern.test(key));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        for (const key of staleKeys) {
          delete next[key];
        }
        return next;
      });
      setAttachmentErrors((prev) => {
        const staleKeys = Object.keys(prev).filter((key) => coldKeyPattern.test(key));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        for (const key of staleKeys) {
          delete next[key];
        }
        return next;
      });
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
  }, [ticketContextToken, projects]);

  useEffect(() => {
    let cancelled = false;
    void fetchChatAgents()
      .then((list) => {
        if (cancelled) {
          return;
        }
        setAgents(list);
        if (list.length > 0) {
          setSelectedAgentId((current) =>
            current === '' ? list[0]!.id : current,
          );
        }
      })
      .catch(() => {
        // エージェント一覧が取れなくてもチャット自体は従来どおり使える
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedAgent === undefined) {
      return;
    }
    const cached = threadModelIds[currentConversationKey];
    if (
      cached !== undefined &&
      (selectedAgent.models ?? []).some((model) => model.id === cached)
    ) {
      setSelectedModelId(cached);
      return;
    }
    const persisted = chatModelSelections[selectedProjectId]?.[selectedAgent.id];
    if (
      persisted !== undefined &&
      (selectedAgent.models ?? []).some((model) => model.id === persisted)
    ) {
      setSelectedModelId(persisted);
      return;
    }
    setSelectedModelId(resolveDefaultModel(selectedAgent));
  }, [
    selectedAgent,
    selectedProjectId,
    currentConversationKey,
    threadModelIds,
    chatModelSelections,
  ]);

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
            messages: payload.messages.map((message) => ({
              role: message.role,
              text: message.content,
              at: Date.parse(message.createdAt),
              ...(message.failedTools !== undefined && message.failedTools.length > 0
                ? { failedTools: message.failedTools }
                : {}),
              ...(message.agentWarnings !== undefined && message.agentWarnings.length > 0
                ? { agentWarnings: message.agentWarnings }
                : {}),
            })),
            sessionId: payload.sessionId,
            agentId: payload.agentId,
          },
        }));
        writePersistedChatThread(selectedProjectId, {
          sessionId: payload.sessionId,
          agentId: payload.agentId,
        });
        // bdboard-2n8: 以前はここで「リクエスト開始時点の selectedAgentId のスナップ
        // ショット(agentIdAtRequestStart, ref経由)」と「現在の selectedAgentId」を
        // 比較し、一致したときだけ復元していた。しかしこのスナップショットは
        // 「エージェント一覧ロード後の既定エージェント自動選択」(下のagents取得
        // useEffect内、`current === '' ? list[0]!.id : current` で1回だけ発火する)
        // でも動いてしまう。そのため初回マウント時に履歴取得より先にエージェント
        // 一覧が解決して既定エージェントが自動セットされる(スナップショットは ''
        // のまま)と、ユーザーは何も手動操作していないのに「不一致」と誤判定され、
        // 永続化されていたエージェントへの復元が失敗していた(stale-ref bug)。
        //
        // 正しく守りたい不変条件は「このレスポンスが今表示中の会話
        // (currentConversationKey)に対応する最新のリクエストである」ことだけで、
        // これは直前の `requestId !== historyRequestIdRef.current` ガードで既に
        // 保証されている(`currentConversationKey` はこの effect の依存配列に
        // 入っており、キーが変わると cleanup で historyRequestIdRef がインクリ
        // メントされ、古い Promise は無効化される)。そして「ユーザーがエージェント
        // を手動変更した」操作(handleAgentChange / handleResumeDiscoveredSession)は
        // 必ず currentConversationKey も変える設計なので、「手動変更があった」ことと
        // 「requestId が古くなる」ことは常に同時に起きる。よって追加のスナップ
        // ショット比較は不要かつ有害で、104.9 のモデル復元(threadModelIds キャッシュ
        // と現在の state だけを見る宣言的な比較)と同じ「現在の state(request の
        // 生存性)との整合チェックだけに頼る」パターンに揃える。
        if (payload.agentId !== '') {
          setSelectedAgentId(payload.agentId);
        }
        if (payload.model !== undefined && payload.model !== '') {
          const restoredModel = payload.model;
          // bdboard-2n8: ユーザーが履歴フェッチの解決を待たずに手動でモデルを
          // 選んでいた場合はそちらを優先し、サーバー復元値で上書きしない。
          // 手動選択は下のモデル select の onChange (handleModelChange) が
          // 既に threadModelIds[currentConversationKey] へ書き込み済みなので
          // (このスレッドが選択中なら currentConversationKey === payload.sessionId)、
          // 「まだ値が無いキーにだけ書く」ことで両立できる。
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
        if (
          error instanceof ApiError &&
          (error.status === 404 ||
            (error.status === 400 && error.errorMessage === 'unknown chat session'))
        ) {
          setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: (prev[selectedProjectId] ?? []).filter((id) => id !== sessionId) }));
          // bdboard-pbf: タブの prune だけだと selectedThreadIds が死んだ
          // セッション id を指したまま残り、handleSubmit のフォールバックが
          // 既知の死亡 id で POST して 400 エラー表示になる (修正前は silent に
          // 新セッションで届いていた)。選択も外してドラフトへ戻し、サーバー側
          // eviction (CHAT_SESSION_MAX_PER_PROJECT) 後の自動回復を維持する。
          //
          // bdboard-23u: pbf デルタレビュー残 nit の続き。ここで threadLists も
          // prune しないと、handleDeleteThread (:1507付近) が prune しているのと
          // 非対称になり、「閉じたスレッドを開く」(threadLists 由来の reopen
          // dropdown、:1608付近) から死亡スレッドを再選択できてしまう。
          // 再選択すると historyLoadedFor はこの effect で既に true 済み扱いの
          // ままなので通常の履歴再取得が起きず、送信すると死亡 id での POST で
          // 400 になる。
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
            // bdboard-23u: handleCloseThread (:1391付近) と同じパターンで選択
            // クリアを localStorage にも同期する。呼ばないと死亡した
            // selectedSessionId が persisted state に残り続ける (reload 時の
            // available フィルタで実害は無いが、handleCloseThread との非一貫は
            // レビュー指摘済み)。
            const nextOpenThreads = (openThreadIdsRef.current[selectedProjectId] ?? []).filter(
              (id) => id !== sessionId,
            );
            writePersistedChatThreadState(selectedProjectId, {
              activeSessionIds: nextOpenThreads,
              selectedSessionId: undefined,
            });
            // bdboard-23u: 最終タブ close (draft nonce を進めない既存の問題) と
            // 同根 — このクリア処理が現在の draft nonce を再利用すると、同じ
            // draftKey に applyChatSuccess が re-key 元として消さずに残した
            // 古い楽観的メッセージが、ドラフトへのフォールバックで再表示されて
            // しまう。handleAgentChange (:1307付近) と同じインラインの nonce
            // 前進パターンに揃える (pendingPrefillRef の消化などプリフィル固有
            // の副作用を伴う startNewDraftThread は、ユーザー起因でないこの
            // 自動回復では意図的に呼ばない)。
            const nextDraftNonce = (draftNoncesRef.current[selectedProjectId] ?? 0) + 1;
            setDraftNonces((prev) => ({ ...prev, [selectedProjectId]: nextDraftNonce }));
          }
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
  }, [selectedProjectId, currentConversationKey, currentSessionId, conversations, historyLoadedFor]);

  // turn-status の回収が完了を取りこぼしたときの安全網 (bdboard-3tw.156)。
  //
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
    // 二重取得の抑止は ref で持つ。印を先に state から外すと、その更新でこの
    // effect 自身が張り直され、走り出した fetch を自分で捨ててしまう。
    if (unresolvedRefetchRef.current.has(sessionId)) return;
    unresolvedRefetchRef.current.add(sessionId);

    const requestId = historyRequestIdRef.current;
    void fetchChatSessionMessages(sessionId, selectedProjectId)
      .then((payload) => {
        // 回収 effect が同じ窓でより新しい状態を書いていたら、そちらを優先する。
        // historyRequestIdRef はこのファイル共通の「この履歴応答はもう古い」印で、
        // スレッドを離れたときにも進むので、離脱後の適用もここで止まる。
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
            messages: payload.messages.map((message) => ({
              role: message.role,
              text: message.content,
              at: Date.parse(message.createdAt),
              ...(message.failedTools !== undefined && message.failedTools.length > 0
                ? { failedTools: message.failedTools }
                : {}),
              ...(message.agentWarnings !== undefined && message.agentWarnings.length > 0
                ? { agentWarnings: message.agentWarnings }
                : {}),
            })),
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
    currentSessionId === undefined
      ? 0
      : (conversations[currentSessionId]?.messages.length ?? 0),
  ]);

  // 表示中の会話にだけ効くストリーミングテキスト。他の会話のストリームで
  // この会話をスクロールしない。
  const activeStreamingText =
    streamingReply !== null && streamingReply.key === currentConversationKey
      ? streamingReply.text
      : '';

  // 「最下部に貼り付いているときだけ追う」。ストリーミング中は
  // activeStreamingText がトークンごとに伸びるので、無条件に最下部へ飛ばすと
  // 利用者が過去ログを読み返せなくなる。逆に追わないと、伸びていく返信が画面
  // 下に隠れたままになる (bdboard-22k の元バグ: deps に streaming が無かった)。
  const pinnedToBottomRef = useRef(true);

  // 直近に effect 自身が代入した scrollTop。プログラム的スクロールでも scroll
  // イベントは飛ぶので、そのイベントを「利用者が動かした」と取り違えないための
  // 目印にする (bdboard-dtr)。
  //
  // 一回限りの「プログラム的スクロール中」フラグにはしない。値が変わらず
  // イベントが飛ばなかった場合にフラグが残り、次の *本物の* 利用者スクロールを
  // 握り潰す — 上へスクロールしても引き戻される、という元バグより悪い症状に
  // なる。現在値との一致で判定すれば冪等なので、取りこぼしても次の
  // イベントで正しく判定し直せる。
  const autoScrolledToRef = useRef<number | null>(null);

  const handleMessagesScroll = useCallback(() => {
    const container = messagesRef.current;
    if (container === null) {
      return;
    }
    // effect が置いた位置から動いていないなら、これは自分で起こしたスクロールの
    // 残響。ここで距離を測ると、イベントが遅れて届く間に次の delta で
    // scrollHeight が伸びていた場合に「利用者が上へスクロールした」と誤判定し、
    // 誰も触っていないのに追従が止まる (bdboard-dtr)。
    //
    // 判定を「触っていない」に倒すだけで、貼り付きを立て直しはしない。effect が
    // 代入するのは貼り付いているときだけなので、正規の残響なら既に true。
    // ここで true を書くと、後述のマーカーと利用者のスクロール位置が偶然
    // 一致したときに勝手に貼り付きへ戻す効果しか持たない (PR#132 レビュー)。
    if (container.scrollTop === autoScrolledToRef.current) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const pinned = distanceFromBottom <= BOTTOM_STICK_THRESHOLD_PX;
    pinnedToBottomRef.current = pinned;
    if (!pinned) {
      // 追うのをやめた時点でマーカーを捨てる。残したままにすると、利用者が
      // 過去ログを読んでいる間ずっと「昔の最下部の座標」が生き続け、そこへ
      // 偶然スクロールが止まったときに上のガードが誤って一致してしまう。
      autoScrolledToRef.current = null;
    }
  }, []);

  // 会話を切り替えたら貼り付き状態に戻す。前の会話で上へスクロールしていた
  // からといって、新しい会話を途中から表示する理由は無い。
  useEffect(() => {
    pinnedToBottomRef.current = true;
    autoScrolledToRef.current = null;
  }, [currentConversationKey]);

  useEffect(() => {
    const container = messagesRef.current;
    if (container !== null && pinnedToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      // ブラウザは範囲外の代入をクランプするので、書いた値ではなく
      // 実際に落ち着いた値を覚える。
      autoScrolledToRef.current = container.scrollTop;
    }
  }, [currentMessages, isSending, activeStreamingText]);

  const showModelSelect = useMemo(
    () => selectedAgent !== undefined && hasSelectableModels(selectedAgent),
    [selectedAgent],
  );

  const handleImagePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith('image/'),
      );
      // 通常のテキスト paste はブラウザへ委ねる。画像を含む paste のときだけ
      // textarea へのバイナリ由来文字列挿入を止める。
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      const attachmentKey = currentConversationKey;
      const validationError = validateChatAttachments(
        conversationAttachmentsRef.current[attachmentKey] ?? [],
        imageFiles,
      );
      if (validationError !== null) {
        setAttachmentErrors((prev) => ({ ...prev, [attachmentKey]: validationError }));
        return;
      }

      void Promise.all(
        imageFiles.map(async (file) => {
          const previewUrl = await readFileAsDataUrl(file);
          attachmentIdRef.current += 1;
          return {
            id: `chat-image-${attachmentIdRef.current}`,
            file,
            mimeType: file.type as ChatImageMimeType,
            previewUrl,
            name: file.name || `貼り付け画像 ${attachmentIdRef.current}`,
            size: file.size,
          } satisfies ChatAttachment;
        }),
      )
        .then((prepared) => {
          // FileReaderの完了前に会話が切り替わった場合、到達不能な旧キーへ
          // 大きなdata URLを残さない。現在の入力欄へ貼り直せる状態を優先する。
          if (currentConversationKeyRef.current !== attachmentKey) return;
          const latestValidationError = validateChatAttachments(
            conversationAttachmentsRef.current[attachmentKey] ?? [],
            imageFiles,
          );
          if (latestValidationError !== null) {
            setAttachmentErrors((prev) => ({
              ...prev,
              [attachmentKey]: latestValidationError,
            }));
            return;
          }
          updateConversationAttachments((prev) => ({
            ...prev,
            [attachmentKey]: [...(prev[attachmentKey] ?? []), ...prepared],
          }));
          setAttachmentErrors((prev) => {
            if (!(attachmentKey in prev)) return prev;
            const next = { ...prev };
            delete next[attachmentKey];
            return next;
          });
        })
        .catch(() => {
          setAttachmentErrors((prev) => ({
            ...prev,
            [attachmentKey]: '画像を読み込めませんでした。',
          }));
        });
    },
    [currentConversationKey, updateConversationAttachments],
  );

  const removeAttachment = useCallback(
    (attachmentKey: string, attachmentId: string) => {
      if (isSending) return;
      updateConversationAttachments((prev) => ({
        ...prev,
        [attachmentKey]: (prev[attachmentKey] ?? []).filter(
          (attachment) => attachment.id !== attachmentId,
        ),
      }));
      setAttachmentErrors((prev) => {
        if (!(attachmentKey in prev)) return prev;
        const next = { ...prev };
        delete next[attachmentKey];
        return next;
      });
    },
    [isSending, updateConversationAttachments],
  );

  /**
   * 描画にも送信にもこの派生値だけを使う。エージェントを切り替えた直後の1フレームは
   * selectedModelId が前のエージェントのモデルIDのままなので、state を直接使うと
   * 「どのオプションにも一致しない select」や「前のエージェントのモデルでの送信」が
   * 一瞬成立してしまう。上の useEffect は state 側を追随させるだけの役割にする。
   */
  const effectiveModelId = useMemo(() => {
    if (selectedAgent === undefined) {
      return '';
    }
    const models = selectedAgent.models ?? [];
    if (models.some((model) => model.id === selectedModelId)) {
      return selectedModelId;
    }
    return resolveDefaultModel(selectedAgent);
  }, [selectedAgent, selectedModelId]);

  const applyChatSuccess = useCallback(
    (convKey: string, sentText: string, result: ChatMessageResponseDto) => {
      setConversations((prev) => {
        const next = {
          ...prev,
          [result.sessionId]: {
          messages: [
            ...(prev[convKey]?.messages ?? []),
            {
              role: 'assistant' as const,
              text: result.reply,
              at: Date.now(),
              ...(result.failedTools !== undefined && result.failedTools.length > 0
                ? { failedTools: result.failedTools }
                : {}),
              ...(result.agentWarnings !== undefined && result.agentWarnings.length > 0
                ? { agentWarnings: result.agentWarnings }
                : {}),
            },
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
      let errorText: string;
      let clearSession = false;
      const accessMessage = writeAccessErrorMessage(error);
      if (accessMessage !== null) {
        errorText = accessMessage;
      } else if (error instanceof ApiError) {
        if (error.status === 403) errorText = 'チャットを利用する権限がありません。';
        else if (error.status === 409) {
          // bdboard-yzn: writeAccessMessage.ts の CHAT_BUSY_HELP と共有し、文言の fork を防ぐ。
          errorText = CHAT_BUSY_HELP;
        } else if (error.status === 400 && error.errorMessage === 'unknown chat session') {
          errorText = '会話の続きが失われました。もう一度送信してください。';
          clearSession = true;
        } else if (error.status === 400 && error.errorMessage === 'chat agent mismatch') {
          errorText = 'エージェントが切り替わったため、会話をやり直します。もう一度送信してください。';
          clearSession = true;
        } else if (
          error.status === 400 &&
          error.errorMessage === 'chat agent does not support image attachments'
        ) {
          errorText = 'このエージェントは画像入力に対応していません。画像対応エージェントへ切り替えるか、画像を削除してください。';
        } else if (error.status === 404) errorText = 'プロジェクトが見つかりません。';
        else if (error.status === 502 && error.code === 'agent-workspace-untrusted') {
          // bdboard-l1t.5 Opus 再レビュー DF1: サーバー側は agent-workspace-untrusted
          // (chat-agent.ts) を返しているのに、ここで拾わないと汎用の
          // error.errorMessage ('chat failed') しか出ず利用者に理由が伝わらない。
          errorText = 'このプロジェクト(ワークスペース)を cursor-agent に信頼させる必要があります。bdboard の外で一度 cursor-agent を対話実行し、ワークスペース信頼プロンプトに答えてから、もう一度送信してください。';
        } else if (error.status === 502 && error.code === 'agent-headless-denied') {
          // bdboard-l1t.6 Opus レビュー SF1 (l1t.5 DF1 と同型): agy の headless モードが
          // ツール呼び出しを自動拒否して空応答になったケース。汎用文言では利用者に
          // 「運用者側の許可設定が要る」ことが伝わらないため、code をマップして案内する。
          errorText = 'エージェントの headless モードがツール呼び出しを自動拒否したため、応答を得られませんでした。bdboard の外で agy 側の設定 (~/.gemini/antigravity-cli/settings.json) の permissions.allow に bd コマンドの許可ルール(例: "command(bd)")を追加してから、もう一度送信してください。';
        } else errorText = error.errorMessage ?? error.message;
      } else if (error instanceof Error) errorText = error.message;
      else errorText = '送信に失敗しました';

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
        setConversationInputs((prev) => ({ ...prev, [convKey]: sentText }));
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
    [selectedProjectId, updateConversationAttachments],
  );

  const submitChatMessage = useCallback(
    async (
      text: string,
      sentRawText: string,
      sentAttachments: readonly ChatAttachment[],
    ) => {
      if (
        (text === '' && sentAttachments.length === 0) ||
        isSending ||
        selectedProjectId === '' ||
        isHistoryPending ||
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
          setAttachmentErrors((prev) => ({
            ...prev,
            [currentConversationKey]: '画像を送信形式に変換できませんでした。',
          }));
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
      setConversationInputs((prev) => ({
        ...prev,
        [currentConversationKey]: '',
      }));
      updateConversationAttachments((prev) => ({
        ...prev,
        [currentConversationKey]: [],
      }));
      setBackgroundTurnStatus({ state: 'idle' });
      setIsSending(true);
      const sendKey = currentConversationKey;
      const requestController = new AbortController();
      requestAbortControllerRef.current = requestController;

      try {
        if (selectedAgent?.supportsStreaming === true) {
          setStreamingReply({ key: sendKey, text: '' });
          try {
            const result = await postChatMessageStream(
              messagePayload,
              {
                onDelta: (delta) =>
                  setStreamingReply((prev) =>
                    prev !== null && prev.key === sendKey
                      ? { key: sendKey, text: prev.text + delta }
                      : prev,
                  ),
              },
              requestController.signal,
            );
            applyChatSuccess(sendKey, text, result);
          } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
              // unmount / スレッド切替 / プロジェクト切替由来の意図的 abort。
              // エラーバブルや入力欄復元は行わない。同一 project 内のスレッド
              // 切替では selectedProjectId が変わらないため、status 回収 effect を
              // generation で明示的に再起動する。
              setTurnRecoveryGeneration((generation) => generation + 1);
              // 回収が取りこぼしたときの安全網 (bdboard-3tw.156)。
              markUnresolvedSend(sessionId);
            } else {
              applyChatError(sendKey, sentRawText, sentAttachments, error, sentAt);
            }
          } finally {
            setStreamingReply(null);
          }
        } else {
          try {
            const result = await postChatMessage(messagePayload, requestController.signal);
            applyChatSuccess(sendKey, text, result);
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
      applyChatSuccess,
      applyChatError,
      updateConversationAttachments,
      markUnresolvedSend,
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
      const prompt = command.prompt;
      draftSeedTextRef.current[currentConversationKey] = prompt;
      setConversationInputs((prev) => ({
        ...prev,
        [currentConversationKey]: prompt,
      }));
      requestAnimationFrame(() => {
        const textarea = inputRef.current;
        if (textarea === null) {
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(prompt.length, prompt.length);
      });
    },
    [currentConversationKey, isHistoryPending, isSending, selectedProjectId],
  );

  const handleModelChange = useCallback(
    (nextModelId: string) => {
      setSelectedModelId(nextModelId);
      // bdboard-2n8: このキャッシュ書き込みの理由は上の threadModelIds 宣言部の
      // コメントを参照(履歴フェッチとの競合防止 / ドラフトスレッドでの保持)。
      setThreadModelIds((prev) => ({
        ...prev,
        [currentConversationKey]: nextModelId,
      }));
      if (selectedAgentId !== '' && selectedProjectId !== '') {
        setChatModelSelections((prev) => ({
          ...prev,
          [selectedProjectId]: {
            ...(prev[selectedProjectId] ?? {}),
            [selectedAgentId]: nextModelId,
          },
        }));
      }
    },
    [currentConversationKey, selectedAgentId, selectedProjectId, setChatModelSelections],
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
      setDraftNonces((prev) => ({ ...prev, [selectedProjectId]: nextDraftNonce }));
      // MF1(N1: startNewDraftThread の SF1 引き継ぎと同じ family ——
      // 「表示キーが切り替わるなら、旧キーの編集を新キーへ引き継ぐ」という
      // 不変条件): エージェント切替は会話キーを強制的に新しいドラフトへ進める
      // が、その瞬間まで入力欄にあった書きかけの本文(既存スレッド閲覧中でも
      // ドラフト中でも)はユーザーがまだ送信していない作業なので、失わせず
      // 新しいドラフトキーへ引き継ぐ。「新規スレッド」ボタン
      // (handleNewThread→startNewDraftThread)は明示的な新規作成の意図なので、
      // こちらは従来どおり引き継がず空のドラフトのままにする。
      setConversationInputs((prev) => ({
        ...prev,
        [nextDraftKey]: prev[currentConversationKey] ?? '',
      }));
      updateConversationAttachments((prev) => {
        const moved = [...(prev[currentConversationKey] ?? [])];
        const next = { ...prev };
        delete next[currentConversationKey];
        return { ...next, [nextDraftKey]: moved };
      });
      // SFX: 値と一緒に draftSeedTextRef のシード記録も無条件でコピーする。値だけ
      // コピーしてシード記録を移し忘れると、新キーでは
      // draftSeedTextRef.current[nextDraftKey] が undefined のままになり、後で
      // startNewDraftThread がこの新キーを previousDraftKey として比較する際
      // 「シード記録が無い」→無条件で「編集済み」と誤判定してしまう(旧キーが
      // 実際には未編集のプリフィルそのままだった場合でも、次のチケット起動で
      // その旧文言が居座ってプリフィルが適用されない)。値とシードを同時に
      // コピーしておけば、新キーでの「value === seed」判定結果が旧キーでの
      // 判定結果と完全に一致するので、条件分岐は不要。
      if (currentConversationKey in draftSeedTextRef.current) {
        draftSeedTextRef.current[nextDraftKey] = draftSeedTextRef.current[currentConversationKey];
      } else {
        delete draftSeedTextRef.current[nextDraftKey];
      }
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
    [selectedProjectId, currentConversationKey, updateConversationAttachments],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        formRef.current?.requestSubmit();
      }
    },
    [],
  );

  const openThreads = openThreadIds[selectedProjectId] ?? [];
  const threadById = new Map((threadLists[selectedProjectId] ?? []).map((thread) => [thread.sessionId, thread]));
  // 開いているスレッドの並びは openThreadIds の挿入順(古いものが先)なので、
  // ここで新しい順に並べ直す。openThreadIds 自体は並べ替えない — あれは
  // 「どのスレッドを開いているか」の永続状態で、表示順とは別物 (bdboard-3tw.154)。
  const displayedOpenThreads = [...openThreads].sort((a, b) =>
    compareThreadsNewestFirst(threadById.get(a), threadById.get(b)),
  );
  // 閉じたスレッドはサーバーが更新の新しい順で返すが、送信直後にローカルで
  // 末尾へ差し込む経路 (下の setThreadLists) があるので、表示側でも並べ直して
  // 取得元の順序に依存しないようにしておく。
  const closedThreads = (threadLists[selectedProjectId] ?? [])
    .filter((thread) => !openThreads.includes(thread.sessionId))
    .sort(compareThreadsNewestFirst);
  const hasClosedThreads = closedThreads.length > 0;
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
    setAttachmentErrors((prev) => {
      if (!(currentConversationKey in prev)) return prev;
      const next = { ...prev };
      delete next[currentConversationKey];
      return next;
    });
    startNewDraftThread(selectedProjectId);
  };
  const handleCloseThread = (sessionId: string) => {
    const next = openThreads.filter((id) => id !== sessionId);
    const selectedSessionId = selectedThreadIds[selectedProjectId];
    const wasSelected = selectedSessionId === sessionId;
    // フォールバック先は openThreadIds の挿入順(next[0] = 最古)ではなく、
    // displayedOpenThreads と同じ表示順(新しい順)の先頭に合わせる。3tw.154 で
    // 表示順を挿入順→新しい順に変えたことで、挿入順の先頭のままだと選択が
    // 見た目の最下段へ飛ぶ不整合が生じていた (bdboard-3tw.157)。
    const nextDisplayed = [...next].sort((a, b) =>
      compareThreadsNewestFirst(threadById.get(a), threadById.get(b)),
    );
    const nextSelectedSessionId = wasSelected ? nextDisplayed[0] : selectedSessionId;
    setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: next }));
    if (wasSelected) {
      setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: nextDisplayed[0] }));
    }
    writePersistedChatThreadState(selectedProjectId, { activeSessionIds: next, selectedSessionId: nextSelectedSessionId });
    if (confirmingDeleteSessionId === sessionId) {
      setConfirmingDeleteSessionId(null);
    }
    if (renamingSessionId === sessionId) {
      setRenamingSessionId(null);
    }
  };
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
    setConfirmingDeleteSessionId(null);
    setLoadingHistoryFor((prev) => (prev === sessionId ? null : prev));

    void fetchChatThreads(projectId)
      .then((threads) => {
        setThreadLists((prev) => ({ ...prev, [projectId]: threads }));
      })
      .catch(() => {
        // 一覧の更新に失敗してもタブ表示が「(無題)」になるだけで再開自体は成立している。
      });
  };

  const handleDeleteThread = async (sessionId: string) => {
    try {
      await deleteChatThread(sessionId, selectedProjectId);
      handleCloseThread(sessionId);
      setThreadLists((prev) => ({ ...prev, [selectedProjectId]: (prev[selectedProjectId] ?? []).filter((thread) => thread.sessionId !== sessionId) }));
      setThreadError(null);
    } catch (error) {
      console.error('chat thread delete failed', error);
      setThreadError('スレッドの削除に失敗しました。');
    } finally {
      setConfirmingDeleteSessionId(null);
    }
  };

  const handleRenameConfirm = async (sessionId: string) => {
    const trimmed = renameDraft.trim();
    const patch = trimmed === '' ? { title: null as string | null } : { title: trimmed };
    try {
      const updated = await updateChatThread(sessionId, selectedProjectId, patch);
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).map((thread) =>
          thread.sessionId === sessionId ? updated : thread,
        ),
      }));
      setThreadError(null);
    } catch (error) {
      console.error('chat thread rename failed', error);
      setThreadError('スレッド名の変更に失敗しました。');
    } finally {
      setRenamingSessionId(null);
    }
  };

  const handlePinToggle = async (sessionId: string, pinned: boolean) => {
    try {
      const updated = await updateChatThread(sessionId, selectedProjectId, { pinned: !pinned });
      setThreadLists((prev) => ({
        ...prev,
        [selectedProjectId]: (prev[selectedProjectId] ?? []).map((thread) =>
          thread.sessionId === sessionId ? updated : thread,
        ),
      }));
      setThreadError(null);
    } catch (error) {
      console.error('chat thread pin failed', error);
      setThreadError('ピン留めの変更に失敗しました。');
    }
  };

  const currentThreadTitle =
    currentSessionId !== undefined
      ? (threadById.get(currentSessionId)?.title ?? '(無題)')
      : '新規';
  const chatSettingsSummaryParts = [
    'チャット設定',
    selectedProject?.name,
    currentThreadTitle,
    selectedAgent?.label,
  ].filter((part): part is string => part !== undefined && part !== '');

  // Chat Redesign 1b: スレッド一覧ドロワーの行データ。ピン留めは開いている/
  // 閉じたスレッドのどちらに属していても「ピン留め」節へ寄せ、開いている/
  // 閉じた節には残さない(mutual exclusion)。displayedOpenThreads /
  // closedThreads は既に新しい順にソート済みで、ピン留め優先はこの filter が
  // 担う (filter は相対順序を保つので、節の中は新しい順のまま)。
  const pinnedOpenSessionIds = displayedOpenThreads.filter(
    (sessionId) => threadById.get(sessionId)?.pinned === true,
  );
  const unpinnedOpenSessionIds = displayedOpenThreads.filter(
    (sessionId) => threadById.get(sessionId)?.pinned !== true,
  );
  const pinnedClosedThreadList = closedThreads.filter((thread) => thread.pinned === true);
  const unpinnedClosedThreadList = closedThreads.filter((thread) => thread.pinned !== true);
  const hasVisibleClosedThreads = unpinnedClosedThreadList.length > 0;

  const renderThreadDrawerOpenRow = (sessionId: string) => {
    const thread = threadById.get(sessionId);
    const threadTitle = thread?.title ?? '(無題)';
    const isSelected = currentSessionId === sessionId;
    const isPinned = thread?.pinned ?? false;
    const isRenaming = renamingSessionId === sessionId;
    const isMenuOpen = threadActionMenuSessionId === sessionId;
    const isConfirmingDelete = confirmingDeleteSessionId === sessionId;
    const agentLabel = agents.find((agent) => agent.id === thread?.agentId)?.label ?? thread?.agentId;
    const metaParts = [
      thread !== undefined ? formatThreadUpdatedAt(thread.updatedAt) : undefined,
      agentLabel,
    ].filter((part): part is string => part !== undefined && part !== '');

    return (
      <div
        className={`chat-thread-drawer-item${isSelected ? ' is-selected' : ''}`}
        key={sessionId}
      >
        {isRenaming ? (
          <input
            className="chat-thread-rename-input"
            type="text"
            aria-label={`スレッド「${threadTitle}」の新しいタイトル`}
            value={renameDraft}
            autoFocus
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleRenameConfirm(sessionId);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setRenamingSessionId(null);
              }
            }}
            onBlur={() => void handleRenameConfirm(sessionId)}
          />
        ) : (
          <button
            type="button"
            className="chat-thread-drawer-item-select"
            aria-current={isSelected ? 'true' : undefined}
            onClick={() => {
              setConfirmingDeleteSessionId(null);
              setRenamingSessionId(null);
              setThreadActionMenuSessionId(null);
              setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: sessionId }));
              writePersistedChatThreadState(selectedProjectId, {
                activeSessionIds: openThreads,
                selectedSessionId: sessionId,
              });
              setThreadDrawerOpen(false);
            }}
          >
            {isPinned && (
              <span className="chat-thread-drawer-item-pin" aria-hidden="true">
                📌
              </span>
            )}
            <span className="chat-thread-drawer-item-title">{threadTitle}</span>
            {metaParts.length > 0 && (
              <span className="chat-thread-drawer-item-meta" aria-hidden="true">
                {metaParts.join(' · ')}
              </span>
            )}
          </button>
        )}
        <div className="chat-thread-drawer-item-menu-wrap">
          <button
            type="button"
            className="chat-thread-drawer-item-menu-toggle"
            aria-label={`スレッド「${threadTitle}」の操作`}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            onClick={() =>
              setThreadActionMenuSessionId((prev) => (prev === sessionId ? null : sessionId))
            }
          >
            ⋯
          </button>
          {isMenuOpen && (
            <div
              className="chat-thread-drawer-item-menu"
              role="menu"
              aria-label={`スレッド「${threadTitle}」の操作メニュー`}
            >
              <button
                type="button"
                role="menuitem"
                className="chat-thread-drawer-menu-item"
                onClick={() => {
                  setThreadActionMenuSessionId(null);
                  setConfirmingDeleteSessionId(null);
                  setRenamingSessionId(sessionId);
                  setRenameDraft(thread?.title ?? '');
                }}
              >
                リネーム
              </button>
              <button
                type="button"
                role="menuitem"
                className="chat-thread-drawer-menu-item"
                onClick={() => {
                  setThreadActionMenuSessionId(null);
                  void handlePinToggle(sessionId, isPinned);
                }}
              >
                {isPinned ? 'ピン留め解除' : 'ピン留め'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="chat-thread-drawer-menu-item"
                onClick={() => {
                  setThreadActionMenuSessionId(null);
                  handleCloseThread(sessionId);
                }}
              >
                タブから閉じる
                <span className="chat-thread-drawer-item-menu-hint">
                  履歴は残る。「閉じたスレッド」から戻せる
                </span>
              </button>
              <div className="chat-thread-drawer-item-menu-divider" />
              {isConfirmingDelete ? (
                <button
                  type="button"
                  role="menuitem"
                  className="chat-thread-drawer-menu-item chat-thread-drawer-menu-item-danger"
                  onClick={() => void handleDeleteThread(sessionId)}
                >
                  <span className="chat-thread-delete-icon" aria-hidden="true">
                    🗑
                  </span>
                  本当に削除
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="chat-thread-drawer-menu-item chat-thread-drawer-menu-item-danger"
                  onClick={() => setConfirmingDeleteSessionId(sessionId)}
                >
                  <span className="chat-thread-delete-icon" aria-hidden="true">
                    🗑
                  </span>
                  削除
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderThreadDrawerClosedRow = (thread: ChatThreadDto) => {
    const threadTitle = thread.title ?? '(無題)';
    return (
      <button
        type="button"
        key={thread.sessionId}
        className="chat-thread-drawer-item chat-thread-drawer-item-closed"
        onClick={() => {
          const next = [...openThreads, thread.sessionId];
          setOpenThreadIds((prev) => ({ ...prev, [selectedProjectId]: next }));
          setSelectedThreadIds((prev) => ({ ...prev, [selectedProjectId]: thread.sessionId }));
          writePersistedChatThreadState(selectedProjectId, {
            activeSessionIds: next,
            selectedSessionId: thread.sessionId,
          });
          setThreadDrawerOpen(false);
        }}
      >
        {thread.pinned && (
          <span className="chat-thread-drawer-item-pin" aria-hidden="true">
            📌
          </span>
        )}
        <span className="chat-thread-drawer-item-title">{threadTitle}</span>
      </button>
    );
  };

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
        <div className="detail-header">
          <h2 id="chat-panel-title" className="detail-title">
            チャット
          </h2>
          {/* 見出しの操作は他パネル(チケット詳細/ヘルプ)と同じく
              .detail-header-actions にまとめる。.detail-header は
              justify-content: space-between なので、直下に3つ並べると
              「最大化」が見出しと「閉じる」の中間に浮いてしまう
              (PR#139 レビュー major-2)。 */}
          <div className="detail-header-actions">
            <button
              type="button"
              className="btn chat-panel-maximize"
              onClick={() => setIsChatPanelMaximized((maximized) => !maximized)}
              title={isChatPanelMaximized ? '元の幅に戻す' : '画面幅いっぱいに広げる'}
            >
              {/* aria-pressed は付けない (PR#139 レビュー minor-3)。ラベル自体が
                  「最大化」/「縮小」と入れ替わるので、押下状態も併せて伝えると
                  「縮小、押されています」= 縮小が有効、と逆に読める。ラベルが
                  次にどうなるかを示す通常のボタンとして扱う。 */}
              {isChatPanelMaximized ? '縮小' : '最大化'}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="btn detail-close"
              onClick={requestClose}
            >
              閉じる
            </button>
          </div>
        </div>

        {/* Chat Redesign 1b: タブ帯を「現在のスレッド名+件数」ボタン1つに圧縮し、
            押すと縦一覧ドロワーがかぶさる形に置き換えた。個別のリネーム/ピン留め/
            タブから閉じる/削除は各行の「⋯」メニューへ集約し(旧: 選択中タブにだけ
            並んでいたボタン列)、ピン留め/開いている/閉じた/外部CLIセッションの
            3+1種類を見出しで言葉として示す。
            チャット設定(details)の外に置く: details の body は閉じている間も
            常にレンダリングされる既存バグ(chat-panel-settings-body に
            display:flex を無条件付与しており、UA既定の details:not([open])
            > :not(summary){display:none} を上書きしてしまう)があり、この中に
            置くと chat-messages と座標が重なってクリックを奪われる
            (bdboard-wkl で発見)。スレッド切替は常時表示すべき主導線でもあるため、
            details の外側に出す。 */}
        <div className="chat-thread-switcher">
          <button
            type="button"
            className="chat-thread-switcher-toggle"
            aria-haspopup="dialog"
            aria-expanded={threadDrawerOpen}
            aria-controls="chat-thread-drawer"
            onClick={() => setThreadDrawerOpen((prev) => !prev)}
          >
            <span className="chat-thread-switcher-icon" aria-hidden="true">☰</span>
            <span className="chat-thread-switcher-title">{currentThreadTitle}</span>
            <span className="chat-thread-switcher-count">スレッド {openThreads.length}</span>
          </button>
          <button
            type="button"
            className="btn chat-thread-new"
            aria-label="新しい空のスレッドを開始"
            title="新しい空のスレッドを開始します(今開いているスレッドはそのまま残ります)"
            onClick={() => {
              setThreadDrawerOpen(false);
              handleNewThread();
            }}
          >
            + 新規スレッド
          </button>
        </div>
        {displayedOpenThreads.length === 0 && (
          <p className="chat-thread-empty-hint" role="status">
            {hasClosedThreads
              ? '開いているスレッドはありません。「+ 新規スレッド」で新しく始めるか、スレッド一覧の「閉じたスレッド」から再開できます。'
              : '開いているスレッドはありません。「+ 新規スレッド」で新しく始めてください。'}
          </p>
        )}
        {threadDrawerOpen && (
          <div
            className="chat-thread-drawer-overlay"
            role="presentation"
            onClick={() => setThreadDrawerOpen(false)}
          >
            <div
              id="chat-thread-drawer"
              className="chat-thread-drawer"
              role="dialog"
              aria-label="スレッド一覧"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="chat-thread-drawer-header">
                <span className="chat-thread-drawer-title">スレッド</span>
                <button
                  type="button"
                  className="chat-thread-drawer-close"
                  onClick={() => setThreadDrawerOpen(false)}
                >
                  閉じる
                </button>
              </div>

              {pinnedThreadDrawerRows.length > 0 && (
                <div className="chat-thread-drawer-section">
                  <p className="chat-thread-drawer-section-title">ピン留め</p>
                  {pinnedThreadDrawerRows}
                </div>
              )}

              <div className="chat-thread-drawer-section">
                <p className="chat-thread-drawer-section-title">開いているスレッド</p>
                {openThreadDrawerRows.length > 0 ? (
                  openThreadDrawerRows
                ) : (
                  <p className="chat-thread-drawer-section-empty">
                    他に開いているスレッドはありません。
                  </p>
                )}
              </div>

              {hasVisibleClosedThreads && (
                <div className="chat-thread-drawer-section">
                  <p className="chat-thread-drawer-section-title">閉じたスレッド</p>
                  <p className="chat-thread-drawer-section-hint">
                    履歴は残っています。選ぶと一覧の上に戻ります。
                  </p>
                  {closedThreadDrawerRows}
                </div>
              )}

              {selectedProjectId !== '' && (
                <div className="chat-thread-drawer-section">
                  <p className="chat-thread-drawer-section-title">
                    bdboard 外で動いていた CLI セッション
                  </p>
                  <p className="chat-thread-drawer-section-hint">
                    ターミナルの Claude Code の会話。選ぶと続きから話せます。
                  </p>
                  <button
                    type="button"
                    className="btn chat-discovered-sessions-toggle"
                    onClick={() => setShowDiscoveredSessions((prev) => !prev)}
                    disabled={isSending}
                  >
                    CLIセッションを再開
                  </button>
                  {showDiscoveredSessions && (
                    <DiscoveredSessionsPanel
                      projectId={selectedProjectId}
                      onClose={() => setShowDiscoveredSessions(false)}
                      onResume={(sessionId, agentId, seedMessages) => {
                        handleResumeDiscoveredSession(sessionId, agentId, seedMessages);
                        setThreadDrawerOpen(false);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <details className="chat-panel-settings">
          <summary className="chat-panel-settings-summary">
            {chatSettingsSummaryParts.join(' — ')}
          </summary>
          <div className="chat-panel-settings-body">
        {projects.length <= 1 ? (
          <p className="chat-project-name">{selectedProject?.name ?? '—'}</p>
        ) : (
          <select
            className="chat-project-select"
            aria-label="対象プロジェクト"
            value={selectedProjectId}
            disabled={isSending}
            onChange={(event) => {
              setSelectedProjectId(event.target.value);
              setTicketProjectFallbackNotice(null);
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}

        {ticketProjectFallbackNotice !== null && (
          <p className="chat-ticket-project-fallback-notice" role="status">
            {ticketProjectFallbackNotice}
          </p>
        )}

        {threadError !== null && <p className="chat-message-error chat-thread-error" role="alert">{threadError}</p>}

        {agents.length > 0 && (
          <select
            className="chat-agent-select"
            aria-label="チャットエージェント"
            value={selectedAgentId}
            disabled={isSending}
            onChange={(event) => handleAgentChange(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {formatAgentOptionLabel(agent)}
              </option>
            ))}
          </select>
        )}

        {selectedAgent !== undefined && showModelSelect && (
          <select
            className="chat-model-select"
            aria-label="モデル"
            value={effectiveModelId}
            disabled={isSending}
            onChange={(event) => handleModelChange(event.target.value)}
          >
            {(selectedAgent.models ?? []).map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        )}

        {selectedAgent !== undefined &&
          selectedAgent.availability === 'unavailable' && (
            <p className="chat-agent-availability-note" role="status">
              このエージェントは利用できません（CLI が無いか、認証が通っていません）。
            </p>
          )}

        {selectedAgent !== undefined &&
          selectedAgent.capability !== 'bd-only' && (
            <p className="chat-agent-capability-warning" role="note">
              このエージェントは bd チケット操作以外の権限を持ちます（
              {selectedAgent.capability}）。
            </p>
          )}

        {selectedAgent === undefined || selectedAgent.capability === 'bd-only' ? (
          <p className="detail-help">
            このチャットは localhost からのみ利用できます。AIが実行できるのは、このプロジェクトの
            bdチケット操作(一覧・詳細・claim・状態変更・クローズ・コメント追加)だけです。
          </p>
        ) : null}
          </div>
        </details>

        {/* 送信して初めて 501 に気付く、では遅い (bdboard-70z.9)。 */}
        <PlatformLimitationNotice feature="chat" />

        <div
          ref={messagesRef}
          className="chat-messages"
          role="log"
          aria-live="polite"
          onScroll={handleMessagesScroll}
        >
          {currentMessages.length === 0 &&
            loadingHistoryFor !== currentConversationKey && (
              <p className="empty-message">まだメッセージはありません</p>
            )}
          {loadingHistoryFor === currentConversationKey && (
            <p className="chat-pending">履歴を読み込み中…</p>
          )}
          {!isSending &&
            backgroundTurnProjectId === selectedProjectId &&
            backgroundTurnStatus.state === 'processing' &&
            backgroundTurnStatus.message !== undefined && (
            // プロジェクト単位の busy 粒度に合わせ、sessionId との突き合わせは行わない
            // (bdboard-3tw.104.22 の処理中バナーと同じスコープ。新規セッションは送信時点で
            // sessionId が未確定のため、厳密な会話一致は原理的にできない)。
            <div className="chat-message chat-message-user">
              <p className="chat-message-text">{backgroundTurnStatus.message}</p>
            </div>
          )}
          {!isSending &&
            backgroundTurnProjectId === selectedProjectId &&
            backgroundTurnStatus.state === 'processing' && (
            <p className="chat-pending" role="status">
              返信をバックグラウンドで処理中…
            </p>
          )}
          {!isSending &&
            backgroundTurnProjectId === selectedProjectId &&
            backgroundTurnStatus.state === 'completed' && (
            <p className="chat-pending" role="status">
              バックグラウンドの返信が完了しました。
            </p>
          )}
          {currentMessages.map((message, index) => (
            <div
              key={`${message.at}-${index}`}
              className={`chat-message chat-message-${message.role}`}
            >
              {message.role === 'assistant' ? (
                <MarkdownContent
                  text={message.text}
                  isTicketOnBoard={isTicketOnBoard}
                  onOpenTicket={onOpenTicket}
                  className="chat-message-text"
                />
              ) : (
                <p className="chat-message-text">{message.text}</p>
              )}
              {message.images !== undefined && message.images.length > 0 && (
                <div className="chat-message-images" aria-label="添付画像" role="list">
                  {message.images.map((image, imageIndex) => (
                    <figure key={`${image.previewUrl}-${imageIndex}`} role="listitem">
                      <img src={image.previewUrl} alt={`添付画像: ${image.name}`} />
                      <figcaption>
                        {image.name} · {formatImageSize(image.size)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {message.failedTools !== undefined &&
                message.failedTools.length > 0 && (
                  <p className="chat-message-failed-tools" role="alert">
                    一部のツール呼び出しが実行できませんでした:{' '}
                    {message.failedTools.join(', ')}
                  </p>
                )}
              {message.agentWarnings !== undefined &&
                message.agentWarnings.length > 0 && (
                  <p className="chat-message-agent-warnings" role="alert">
                    エージェントの警告: {message.agentWarnings.join('; ')}
                  </p>
                )}
            </div>
          ))}
          {activeStreamingText !== '' && (
            <div className="chat-message chat-message-assistant chat-message-streaming">
              <p className="chat-message-text">{activeStreamingText}</p>
            </div>
          )}
          {/* bdboard-l1t.9 Opus レビュー N5: streaming で部分テキストが
              表示され始めたら「考え中…」は隠す(両方同時に出ると、もう
              テキストが見えているのに「考え中」と言い続けるのが不自然)。 */}
          {isSending && activeStreamingText === '' && (
            <p className="chat-pending">
              考え中…{sendElapsedSeconds}秒（最大3分かかることがあります）
            </p>
          )}
        </div>

        <form
          ref={formRef}
          className="chat-input-form"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <div
            className="chat-quick-commands"
            role="group"
            aria-label="クイックコマンド"
          >
            {CHAT_QUICK_COMMANDS.map((command) => (
              <button
                key={command.id}
                type="button"
                className="chat-quick-command-chip"
                disabled={
                  isSending || isHistoryPending || selectedProjectId === ''
                }
                aria-label={`${command.label}を入力欄に挿入`}
                onClick={() => handleQuickCommand(command)}
              >
                {command.label}
              </button>
            ))}
          </div>
          {currentAttachments.length > 0 && (
            <div className="chat-attachments" aria-label="送信前の添付画像" role="list">
              {currentAttachments.map((attachment) => (
                <div className="chat-attachment" key={attachment.id} role="listitem">
                  <img
                    className="chat-attachment-preview"
                    src={attachment.previewUrl}
                    alt={`送信前の添付画像: ${attachment.name}`}
                  />
                  <span className="chat-attachment-details">
                    <span className="chat-attachment-name">{attachment.name}</span>
                    <span className="chat-attachment-size">
                      {formatImageSize(attachment.size)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="chat-attachment-remove"
                    aria-label={`添付画像「${attachment.name}」を削除`}
                    disabled={isSending}
                    onClick={() => removeAttachment(currentConversationKey, attachment.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {currentAttachmentError !== null && (
            <p className="chat-attachment-error" role="alert">
              {currentAttachmentError}
            </p>
          )}
          {hasUnsupportedAttachments && (
            <p className="chat-attachment-unsupported" role="alert">
              このエージェントは画像入力に対応していません。画像対応エージェントへ切り替えるか、画像を削除してください。
            </p>
          )}
          <textarea
            ref={inputRef}
            className="chat-input"
            rows={3}
            placeholder="例: in_progress のまま止まっているチケットを教えて"
            aria-label="メッセージ"
            maxLength={4000}
            value={currentInput}
            disabled={isSending || chatUnsupported}
            onChange={(event) => {
              const value = event.target.value;
              setConversationInputs((prev) => ({ ...prev, [currentConversationKey]: value }));
            }}
            onPaste={handleImagePaste}
            onKeyDown={handleKeyDown}
          />
          <button
            type="submit"
            className="btn"
            disabled={
              isSending ||
              isHistoryPending ||
              chatUnsupported ||
              hasUnsupportedAttachments ||
              (currentInput.trim() === '' && currentAttachments.length === 0)
            }
          >
            送信
          </button>
          <span className="chat-input-hint">
            ⌘/Ctrl + Enter で送信 · PNG/JPEG/WebP を貼り付け（最大4枚）
          </span>
          <span className="chat-image-privacy-hint">
            画像はこの画面のメモリ上だけに保持され、履歴 API / localStorage には保存されません。
          </span>
        </form>
      </div>
    </div>
  );
}
