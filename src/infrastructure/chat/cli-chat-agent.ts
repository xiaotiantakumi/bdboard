import { readFileSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  ChatAgentAbortedError,
  ChatAgentError,
  type ChatAgentAvailability,
  type ChatAgentDescriptor,
  type ChatAgentPort,
  type ChatFailureCode,
  type ChatTurnRequest,
  type ChatTurnResult,
} from '../../application/ports/chat-agent.js';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type { StreamingCommandRunner } from '../../application/ports/streaming-command-runner.js';
import { truncate } from '../../domain/text.js';
import { classifyCommandFailure, logChatAgentFailure } from './cli-failure.js';

const MAX_REPLY_CHARS = 20_000;
const AVAILABILITY_TIMEOUT_MS = 5_000;

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

function buildAllowedEnv(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function readArtifactFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * `target` が `directory` 配下(自身は含まない)であることを確認する。
 * 記号リンクは解決しない(scratchDir も lastMessageFile もこのプロセス自身が
 * 書いた一時ファイルパスであり、シンボリックリンク経由の攻撃面を想定していない)。
 */
function isWithinDirectory(target: string, directory: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedDir = path.resolve(directory);
  const relative = path.relative(resolvedDir, resolvedTarget);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 一時ファイルの後始末。失敗してもターンは続行するが、ENOENT以外は警告する。
 * 呼び出し前に `scratchDir` 配下であることを確認しているのを前提とする
 * (bdboard-l1t.4 SF8: spec のバグで scratchDir 外の任意パスが渡ってきても、
 * ここで無関係なファイルを消してしまわないようにするための防御)。
 */
function cleanupArtifactFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // パスや内容はログへ出さない。片付けの失敗でターン自体も失敗させない。
      console.error('chat cli-chat-agent: failed to remove a temporary chat artifact');
    }
  }
}

/**
 * 一時ディレクトリの後始末。失敗してもターンは続行する。
 * 呼び出し前に `scratchDir` 配下であることを確認しているのを前提とする
 * (bdboard-l1t.4 SF8: spec のバグで scratchDir 外の任意パスが渡ってきても、
 * ここで無関係なディレクトリを消してしまわないようにするための防御)。
 * ファイル側の `cleanupArtifactFile` と違って ENOENT の判定を持たないのは、
 * `force: true` が「存在しない」を既に握り潰すため。
 */
function cleanupArtifactDir(dirPath: string): void {
  try {
    rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // パスや内容はログへ出さない。片付けの失敗でターン自体も失敗させない。
    console.error('chat cli-chat-agent: failed to remove a temporary chat artifact directory');
  }
}

function cleanupTurnFiles(
  plan: Pick<CliTurnPlan, 'lastMessageFile' | 'temporaryFiles' | 'temporaryDirs'>,
  ctx: CliTurnContext,
  agentId: string,
): void {
  const files = [
    ...(plan.lastMessageFile !== undefined ? [plan.lastMessageFile] : []),
    ...(plan.temporaryFiles ?? []),
  ];
  for (const filePath of new Set(files)) {
    if (isWithinDirectory(filePath, ctx.scratchDir)) {
      cleanupArtifactFile(filePath);
    } else {
      console.error(
        `chat cli-chat-agent: refusing to delete temporary file outside scratchDir (agent=${agentId}, scratchDir=${ctx.scratchDir}, file=${filePath})`,
      );
    }
  }
  for (const dirPath of new Set(plan.temporaryDirs ?? [])) {
    if (isWithinDirectory(dirPath, ctx.scratchDir)) {
      cleanupArtifactDir(dirPath);
    } else {
      console.error(
        `chat cli-chat-agent: refusing to delete temporary directory outside scratchDir (agent=${agentId}, scratchDir=${ctx.scratchDir}, dir=${dirPath})`,
      );
    }
  }
}

function buildTurnResult(
  parsed: Omit<ChatTurnResult, 'agentId'>,
  agentId: string,
  fallbackModel: string | undefined,
): ChatTurnResult {
  const model = parsed.model ?? fallbackModel;
  return {
    reply: truncate(parsed.reply, MAX_REPLY_CHARS),
    sessionId: parsed.sessionId,
    failedTools: parsed.failedTools,
    agentId,
    ...(model !== undefined ? { model } : {}),
    ...(parsed.agentWarnings !== undefined && parsed.agentWarnings.length > 0
      ? { agentWarnings: parsed.agentWarnings }
      : {}),
  };
}

export function createCliChatAgent(
  commandRunner: CommandRunner,
  spec: CliChatAgentSpec,
  deps: CliChatAgentDeps,
): ChatAgentPort {
  const sourceEnv = deps.env ?? process.env;
  const baseEnv = buildAllowedEnv(sourceEnv, spec.envAllowlist);

  const streamingEnabled =
    spec.supportsStreaming === true &&
    spec.buildStreamingTurn !== undefined &&
    deps.streamingCommandRunner !== undefined;

  return {
    descriptor: spec.descriptor,

    async checkAvailability(): Promise<ChatAgentAvailability> {
      const probe = spec.authProbe;
      const result = await commandRunner.run(
        spec.binaryPath,
        probe?.args ?? spec.versionArgs,
        {
          timeoutMs: AVAILABILITY_TIMEOUT_MS,
          env: baseEnv,
        },
      );

      // バイナリが無い/起動できないのは、判定手段によらず確定で「使えない」。
      if (result.failureKind === 'spawn-failed') {
        return 'unavailable';
      }

      if (probe === undefined) {
        // バージョンが返っただけでは認証状態は何も分からない。'available' と言わない。
        return result.exitCode === 0 ? 'unknown' : 'unavailable';
      }

      return probe.interpret(result);
    },

    async sendMessage(request: ChatTurnRequest): Promise<ChatTurnResult> {
      const ctx = deps.buildContext(request);
      const plan = spec.buildTurn(request, ctx);
      const env = { ...baseEnv };
      if (plan.extraEnv !== undefined) {
        for (const [key, value] of Object.entries(plan.extraEnv)) {
          env[key] = value;
        }
      }

      const runOptions = {
        cwd: request.projectRootPath,
        timeoutMs: spec.timeoutMs,
        env,
        ...(plan.stdin !== undefined ? { input: plan.stdin } : {}),
      };

      const lastMessageFile = plan.lastMessageFile;
      const readLastMessageFile = (): string | undefined =>
        lastMessageFile === undefined ? undefined : readArtifactFile(lastMessageFile);

      try {
        const result = await commandRunner.run(spec.binaryPath, plan.args, runOptions);

        if (result.exitCode !== 0) {
          const code = spec.classifyFailure?.(result) ?? classifyCommandFailure(result);
          logChatAgentFailure({
            agentId: spec.descriptor.id,
            code,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          });
          throw new ChatAgentError(code);
        }

        let parsed: Omit<ChatTurnResult, 'agentId'>;
        try {
          parsed = spec.parseTurn(result, readLastMessageFile);
        } catch (err) {
          if (err instanceof ChatAgentError) {
            logChatAgentFailure({
              agentId: spec.descriptor.id,
              code: err.code,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            });
          }
          throw err;
        }
        // bdboard-l1t.5 Opus レビュー SF6(a): resume ターンで CLI が要求した
        // session_id と違うものを返してくることがある(例: cursor-agent は
        // 存在しない/でたらめな --resume <id> を渡してもエラーにせず、その id を
        // そのまま echo しつつ実際には新規セッションとして応答するサイレント
        // フォールバック挙動が確認できている。詳細は specs/cursor-spec.ts の
        // buildCursorArgs コメント参照)。ここで検知しても致命的エラーにはせず、
        // サーバーログに警告を出すだけに留める(会話自体は継続させる)。
        if (
          request.resumeSessionId !== undefined &&
          parsed.sessionId !== request.resumeSessionId
        ) {
          console.warn(
            `chat cli-chat-agent: resumed session id mismatch (agent=${spec.descriptor.id}, requested=${request.resumeSessionId}, returned=${parsed.sessionId})`,
          );
        }
        return buildTurnResult(
          parsed,
          spec.descriptor.id,
          request.model ?? spec.descriptor.model,
        );
      } finally {
        // ターン外(プロジェクト外の scratchDir)に書かれた一時ファイルは、成功/失敗を
        // 問わずここで必ず片付ける(bdboard-l1t.4 AC: 一時ファイルはターン終了後に残さない)。
        // 削除前に scratchDir 配下であることを確認する(bdboard-l1t.4 SF8): spec の
        // buildTurn がバグって scratchDir 外の任意パスを lastMessageFile に入れて
        // 返してきても、ここで無関係なファイルを消してしまわないようにするため。
        cleanupTurnFiles(plan, ctx, spec.descriptor.id);
      }
    },
    ...(streamingEnabled
      ? {
          async sendMessageStream(
            request: ChatTurnRequest,
            onDelta: (delta: { readonly text: string }) => void,
            signal?: AbortSignal,
          ): Promise<ChatTurnResult> {
            const ctx = deps.buildContext(request);
            const plan = spec.buildStreamingTurn!(request, ctx);
            const env = { ...baseEnv };
            if (plan.extraEnv !== undefined) {
              for (const [key, value] of Object.entries(plan.extraEnv)) {
                env[key] = value;
              }
            }
            const lastMessageFile = plan.lastMessageFile;
            const readLastMessageFile = (): string | undefined =>
              lastMessageFile === undefined ? undefined : readArtifactFile(lastMessageFile);
            let lineBuffer = '';
            const parseLine = (line: string): void => {
              const parsed = spec.parseStreamChunk?.(line);
              if (parsed?.delta !== undefined && parsed.delta.length > 0) {
                onDelta({ text: parsed.delta });
              }
            };

            try {
              const result = await deps.streamingCommandRunner!.run(
                spec.binaryPath,
                plan.args,
                {
                  cwd: request.projectRootPath,
                  timeoutMs: spec.timeoutMs,
                  env,
                  ...(plan.stdin !== undefined ? { input: plan.stdin } : {}),
                  ...(signal !== undefined ? { signal } : {}),
                  onChunk(chunk) {
                    if (chunk.stream !== 'stdout') {
                      return;
                    }
                    lineBuffer += chunk.text;
                    const lines = lineBuffer.split('\n');
                    lineBuffer = lines.pop() ?? '';
                    for (const line of lines) {
                      parseLine(line.endsWith('\r') ? line.slice(0, -1) : line);
                    }
                  },
                },
              );
              if (lineBuffer.length > 0) {
                parseLine(lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer);
              }

              if (result.failureKind === 'aborted') {
                throw new ChatAgentAbortedError();
              }
              if (result.exitCode !== 0) {
                // bdboard-l1t.9 Opus レビュー S8: 'buffer-limit-exceeded' は
                // StreamingCommandFailureKind にしかない値(CommandFailureKind は
                // spawn-failed/timeoutのみ)なので、CommandResult へはそのまま渡せない
                // (渡すとバッファ超過が意味的に無関係な分類に化けかねない)。
                // classifyCommandFailure には spawn-failed/timeout だけを渡し、
                // バッファ超過はログの note だけに残す。
                const commandResult: CommandResult = {
                  stdout: result.stdout,
                  stderr: result.stderr,
                  exitCode: result.exitCode,
                  ...(result.failureKind === 'spawn-failed' || result.failureKind === 'timeout'
                    ? { failureKind: result.failureKind }
                    : {}),
                };
                const code = spec.classifyFailure?.(commandResult) ?? classifyCommandFailure(commandResult);
                logChatAgentFailure({
                  agentId: spec.descriptor.id,
                  code,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  ...(result.failureKind === 'buffer-limit-exceeded'
                    ? { note: 'buffer-limit-exceeded' }
                    : {}),
                });
                throw new ChatAgentError(code);
              }
              if (spec.parseStreamResult === undefined) {
                throw new Error('streaming spec must define parseStreamResult');
              }
              let parsed: Omit<ChatTurnResult, 'agentId'>;
              try {
                parsed = spec.parseStreamResult(result.stdout, readLastMessageFile);
              } catch (err) {
                if (err instanceof ChatAgentError) {
                  logChatAgentFailure({
                    agentId: spec.descriptor.id,
                    code: err.code,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                  });
                }
                throw err;
              }
              return buildTurnResult(parsed, spec.descriptor.id, request.model ?? spec.descriptor.model);
            } finally {
              cleanupTurnFiles(plan, ctx, spec.descriptor.id);
            }
          },
        }
      : {}),
  };
}
