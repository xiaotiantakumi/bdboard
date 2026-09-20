import type {
  ChatAgentAvailability,
  ChatAgentDescriptor,
  ChatFailureCode,
  ChatTurnRequest,
  ChatTurnResult,
} from '../../../application/ports/chat-agent.js';
import type { CommandResult } from '../../../application/ports/command-runner.js';
import type { StreamingCommandRunner } from '../../../application/ports/streaming-command-runner.js';

export interface CliMcpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface CliTurnContext {
  readonly systemPrompt: string;
  readonly mcpServers: readonly CliMcpServerSpec[];
  readonly toolNames: readonly string[];
  readonly scratchDir: string;
}

export interface CliTurnPlan {
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * CLI に「最終メッセージをここへ書け」と指示したファイルの絶対パス
   * (例: codex の -o/--output-last-message)。指定する場合は必ず
   * ctx.scratchDir 配下(プロジェクト外)のパスにすること。ターン終了後、
   * 成功/失敗を問わず createCliChatAgent 側が自動で削除する。
   */
  readonly lastMessageFile?: string;
  /**
   * spec がターン用に作成した入力 artifact。成功・子プロセス失敗・parse 失敗・
   * streaming 終了のすべてで、scratchDir 配下のものだけを自動削除する。
   */
  readonly temporaryFiles?: readonly string[];
  /**
   * spec がターン用に作成した一時ディレクトリ。成功・子プロセス失敗・parse 失敗・
   * streaming 終了のすべてで、scratchDir 配下のものだけを中身ごと再帰削除する。
   */
  readonly temporaryDirs?: readonly string[];
}

/**
 * 認証まで含めた可用性の判定手段。CLI ごとにやり方が違うので spec に持たせる。
 * **課金の発生するモデル呼び出しをここに書いてはいけない**(bdboard-15v)。
 * 実プロンプトを投げる引数を渡さないこと。
 */
export interface CliAuthProbe {
  readonly args: readonly string[];
  /** 起動に成功したときの結果から可用性を判定する。判断がつかないときは 'unknown' を返すこと。 */
  interpret(result: CommandResult): ChatAgentAvailability;
}

export interface CliChatAgentSpec {
  readonly descriptor: ChatAgentDescriptor;
  readonly binaryPath: string;
  readonly envAllowlist: readonly string[];
  readonly versionArgs: readonly string[];
  /**
   * 省略可。省略した場合は versionArgs にフォールバックするが、
   * それが成功しても 'unknown' 止まり(インストール済み・認証は未検証)。
   */
  readonly authProbe?: CliAuthProbe;
  readonly timeoutMs: number;
  readonly supportsStreaming?: boolean;
  buildTurn(request: ChatTurnRequest, ctx: CliTurnContext): CliTurnPlan;
  readonly buildStreamingTurn?: (request: ChatTurnRequest, ctx: CliTurnContext) => CliTurnPlan;
  readonly parseStreamChunk?: (line: string) => { readonly delta?: string } | undefined;
  readonly parseStreamResult?: (
    fullStdout: string,
    readLastMessageFile: () => string | undefined,
  ) => Omit<ChatTurnResult, 'agentId'>;
  /**
   * 省略可。exitCode !== 0 のとき、汎用の classifyCommandFailure(spawn-failed/
   * timeout/それ以外 の3値)より詳しい分類が要る spec だけが実装する。値を返せば
   * それを優先し、undefined を返した(または spec 自体が未実装の)場合は
   * classifyCommandFailure にフォールバックする(bdboard-l1t.5 Opus レビュー SF1:
   * cursor アダプタがワークスペース未信頼エラーを 'agent-workspace-untrusted' として
   * 見分けるのに使う。実装は specs/cursor-spec.ts を参照)。
   */
  classifyFailure?(result: CommandResult): ChatFailureCode | undefined;
  /**
   * CLI 出力から実測値を取得できる場合は `model` に入れる。省略した場合は
   * `buildTurnResult` が `request.model ?? descriptor.model` にフォールバックする。
   * `model` には実測値のみを入れること。要求値のエコーを入れてはならない
   * (エコーは `buildTurnResult` の責務)。
   *
   * 第二引数 `readLastMessageFile` は、同じターンの buildTurn が返した
   * plan.lastMessageFile の中身を読む 0 引数アクセサ(sendMessage が
   * クロージャで束縛して渡す)。buildTurn / parseTurn は spec 上の別々の
   * 関数でターンごとの相関を持たないため、この形にしてある。
   * plan.lastMessageFile を使わない spec (stdout の JSON だけで完結する CLI)
   * は無視してよい — 常に undefined が返る。
   */
  parseTurn(
    result: CommandResult,
    readLastMessageFile: () => string | undefined,
  ): Omit<ChatTurnResult, 'agentId'>;
}

export interface CliChatAgentDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly buildContext: (request: ChatTurnRequest) => CliTurnContext;
  readonly streamingCommandRunner?: StreamingCommandRunner;
}
