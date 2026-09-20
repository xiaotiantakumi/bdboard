import type {
  ChatAgentAvailability,
  ChatAgentPort,
} from '../../../application/ports/chat-agent.js';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { buildAllowedEnv } from './env.js';
import { sendMessage } from './send-message.js';
import { sendMessageStream } from './send-message-stream.js';
import type { CliChatAgentDeps, CliChatAgentSpec } from './types.js';

const AVAILABILITY_TIMEOUT_MS = 5_000;

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

    sendMessage: (request) => sendMessage(commandRunner, spec, deps, baseEnv, request),

    ...(streamingEnabled
      ? {
          sendMessageStream: (request, onDelta, signal) =>
            sendMessageStream(spec, deps, baseEnv, request, onDelta, signal),
        }
      : {}),
  };
}
