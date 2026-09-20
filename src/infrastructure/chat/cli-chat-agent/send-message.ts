import {
  ChatAgentError,
  type ChatTurnRequest,
  type ChatTurnResult,
} from '../../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { classifyCommandFailure, logChatAgentFailure } from '../cli-failure.js';
import { cleanupTurnFiles, readArtifactFile } from './artifact-files.js';
import { buildTurnResult } from './turn-result.js';
import type { CliChatAgentDeps, CliChatAgentSpec } from './types.js';

export async function sendMessage(
  commandRunner: CommandRunner,
  spec: CliChatAgentSpec,
  deps: CliChatAgentDeps,
  baseEnv: Record<string, string>,
  request: ChatTurnRequest,
): Promise<ChatTurnResult> {
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
}
