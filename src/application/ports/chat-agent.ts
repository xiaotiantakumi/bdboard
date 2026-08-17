export interface ChatTurnRequest {
  readonly projectRootPath: string;
  readonly projectName: string;
  readonly message: string;
  readonly resumeSessionId?: string;
  readonly model?: string;
}

export type ChatAgentCapability = 'bd-only' | 'reads-project' | 'unrestricted';

export interface ChatModelOption {
  readonly id: string;
  readonly label: string;
  /**
   * このモデルの相対レート制限コスト(bdboard-3tw.104.11)。宣言しない場合は
   * 呼び出し側の既定重みにフォールバックする。重みの知識を各 spec 自身に
   * 宣言させることで、chat-rate-limit.ts 側での文字列マッチによる複製を無くす。
   */
  readonly weight?: number;
}

export interface ChatAgentDescriptor {
  readonly id: string;
  readonly label: string;
  readonly model?: string;
  readonly models?: readonly ChatModelOption[];
  readonly experimental: boolean;
  readonly capability: ChatAgentCapability;
  readonly supportsStreaming?: boolean;
}

/**
 * 可用性の三値(bdboard-15v)。boolean だと「CLI はあるが認証が切れている」を
 * available=true と嘘をつくしかない。
 * - 'available'   : 認証まで含めて使えることが確認できた
 * - 'unknown'     : CLI は起動できたが認証状態を確認できなかった(判定手段が無い / 出力が読めない)
 * - 'unavailable' : CLI が起動できない、または認証が通っていないことが確認できた
 */
export const CHAT_AGENT_AVAILABILITIES = [
  'available',
  'unknown',
  'unavailable',
] as const;

export type ChatAgentAvailability = (typeof CHAT_AGENT_AVAILABILITIES)[number];

export interface ChatTurnResult {
  readonly reply: string;
  readonly sessionId: string;
  /**
   * このターンで失敗したツール呼び出しの名前一覧(拒否/エラー問わず、CLI が
   * 「失敗した」と報告したもの全て)。命名は当初 `deniedTools` だったが、
   * codex アダプタの `status === 'failed'` は権限拒否以外のエラーも含み得るため
   * `failedTools` に改称した(DTO/UI 側とも統一。bdboard-l1t.4)。
   */
  readonly failedTools: readonly string[];
  readonly agentId: string;
  /**
   * CLI が実際に使ったモデルを返せる場合はその実測値、取得できない場合は
   * `request.model ?? descriptor.model` の要求値のエコー。claude CLI では
   * bdboard-3tw.104.8 の調査結果に基づき、非公式・未文書化の `modelUsage` から
   * `costUSD` 最大のエントリを実測値として採用する。これは経験的な観測に
   * 基づく実装であり、CLI のバージョンアップで壊れる可能性がある。
   */
  readonly model?: string;
}

/**
 * クライアントに返してよい失敗分類。子プロセスの出力を一切含まない閉じた集合。
 * 生の stdout/stderr はサーバーログにのみ出す(bdboard-pvl)。
 */
export const CHAT_FAILURE_CODES = [
  'agent-not-found',
  'agent-timeout',
  'agent-exit-nonzero',
  'agent-bad-output',
  'agent-unexpected-output',
  /**
   * cursor アダプタ専用(bdboard-l1t.5)。cursor-agent CLI がターゲットディレクトリを
   * 未信頼と判断し、ワークスペース信頼プロンプトの代わりに固定のエラーメッセージを
   * stderr に出して exit 1 する場合に立つ(検出ロジックは
   * src/infrastructure/chat/specs/cursor-spec.ts の classifyFailure を参照)。
   * 生の stderr は含めず、定型文だけを返す(bdboard-pvl)。
   */
  'agent-workspace-untrusted',
  /**
   * cursor アダプタ専用(bdboard-l1t.5 Opus 再レビュー DF6)。CLI 自身が
   * `is_error: true` を報告したケース専用のコード。JSON の shape 自体は
   * schema どおり正常(session_id/result とも揃っている)なので、shape 異常を
   * 示す 'agent-unexpected-output' を使うと利用者を誤誘導する
   * (「CLI の出力形式が壊れた」と読める)。実際にはツール側が内部的に
   * エラーだったと自己申告しているだけなので専用コードに分ける。
   * 検出ロジックは src/infrastructure/chat/specs/cursor-spec.ts の
   * parseTurn を参照。
   */
  'agent-reported-error',
  /** agy headless mode auto-denied an approval-required tool call (bdboard-l1t.6). */
  'agent-headless-denied',
] as const;

export type ChatFailureCode = (typeof CHAT_FAILURE_CODES)[number];

/** 公開してよい定型文。ここ以外から detail を作らないこと。 */
export const CHAT_FAILURE_MESSAGES: Readonly<Record<ChatFailureCode, string>> = {
  'agent-not-found': 'the chat agent CLI could not be started',
  'agent-timeout': 'the chat agent timed out',
  'agent-exit-nonzero': 'the chat agent exited with an error',
  'agent-bad-output': 'the chat agent returned output that is not valid JSON',
  'agent-unexpected-output': 'the chat agent returned JSON in an unexpected shape',
  'agent-workspace-untrusted':
    'the chat agent requires this project directory to be trusted outside bdboard before it can run non-interactively',
  'agent-reported-error': 'the chat agent reported an internal error for this turn',
  'agent-headless-denied': 'the chat agent auto-denied a tool call that its headless mode cannot approve; the agy CLI needs an operator-side permissions.allow rule for the bd command (see README)',
};

/**
 * 失敗コードしか受け取らない。文字列を受け取らないのが本体の安全性で、
 * 「生の子プロセス出力を detail に混ぜる」経路を型レベルで塞いでいる(bdboard-pvl)。
 * デバッグ用の詳細は投げる側が console.error でサーバーログに出す。
 */
export class ChatAgentError extends Error {
  readonly detail: string;

  constructor(readonly code: ChatFailureCode) {
    super(CHAT_FAILURE_MESSAGES[code]);
    this.detail = CHAT_FAILURE_MESSAGES[code];
    this.name = 'ChatAgentError';
  }
}

export interface ChatStreamDelta {
  readonly text: string;
}

export class ChatAgentAbortedError extends Error {
  constructor() {
    super('the chat agent request was aborted');
    this.name = 'ChatAgentAbortedError';
  }
}

export interface ChatAgentPort {
  readonly descriptor: ChatAgentDescriptor;
  checkAvailability(): Promise<ChatAgentAvailability>;
  sendMessage(request: ChatTurnRequest): Promise<ChatTurnResult>;
  sendMessageStream?(
    request: ChatTurnRequest,
    onDelta: (delta: ChatStreamDelta) => void,
    signal?: AbortSignal,
  ): Promise<ChatTurnResult>;
}
