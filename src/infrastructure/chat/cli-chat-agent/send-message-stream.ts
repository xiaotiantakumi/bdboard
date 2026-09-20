import {
  ChatAgentAbortedError,
  ChatAgentError,
  type ChatTurnRequest,
  type ChatTurnResult,
} from '../../../application/ports/chat-agent.js';
import type { CommandResult } from '../../../application/ports/command-runner.js';
import { classifyCommandFailure, logChatAgentFailure } from '../cli-failure.js';
import { cleanupTurnFiles, readArtifactFile } from './artifact-files.js';
import { buildTurnResult } from './turn-result.js';
import type { CliChatAgentDeps, CliChatAgentSpec } from './types.js';

export async function sendMessageStream(
  spec: CliChatAgentSpec,
  deps: CliChatAgentDeps,
  baseEnv: Record<string, string>,
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
}
