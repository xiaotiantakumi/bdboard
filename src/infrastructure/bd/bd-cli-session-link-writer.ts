import type { CommandRunner } from '../../application/ports/command-runner.js';
import {
  BdError,
  type BdErrorKind,
} from '../../application/ports/issue-repository.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import { isSafeCliArgument, isValidBdTicketId } from '../../domain/chat.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

/** bd update --set-metadata / --unset-metadata で読み書きするキー名。 */
export const SESSION_LINK_METADATA_KEY = 'bdboard.session';

export interface BdCliSessionLinkWriterOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

function classifyBdError(
  exitCode: number,
  combinedOutput: string,
): BdErrorKind {
  if (
    combinedOutput.includes('not a beads project') ||
    combinedOutput.includes('no .beads') ||
    combinedOutput.includes('.beads not found') ||
    combinedOutput.includes('beads directory')
  ) {
    return 'not-a-beads-project';
  }

  if (
    exitCode === 127 ||
    exitCode === -1 ||
    combinedOutput.includes('command not found') ||
    combinedOutput.includes('enoent') ||
    combinedOutput.includes('not found')
  ) {
    return 'bd-not-found';
  }

  if (combinedOutput.includes('lock')) {
    return 'lock-contention';
  }

  return 'unknown';
}

async function runUpdate(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  metadataArgs: readonly string[],
): Promise<void> {
  const result = await commandRunner.run(
    bdPath,
    ['-C', rootPath, 'update', ticketId, ...metadataArgs],
    { cwd: rootPath, timeoutMs },
  );

  if (result.exitCode !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    const kind = classifyBdError(result.exitCode, combined);
    throw new BdError(
      kind,
      ticketId,
      combined.trim() || `exit code ${result.exitCode}`,
    );
  }
}

export function createBdCliSessionLinkWriter(
  commandRunner: CommandRunner,
  options?: BdCliSessionLinkWriterOptions,
): SessionLinkWriterPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async linkSession(
      rootPath: string,
      ticketId: string,
      sessionId: string,
    ): Promise<void> {
      if (!isValidBdTicketId(ticketId)) {
        throw new BdError('unknown', ticketId, 'invalid ticket id');
      }
      if (!isSafeCliArgument(sessionId)) {
        throw new BdError('unknown', ticketId, 'invalid session id');
      }

      await runUpdate(commandRunner, bdPath, timeoutMs, rootPath, ticketId, [
        '--set-metadata',
        `${SESSION_LINK_METADATA_KEY}=${sessionId}`,
      ]);
    },

    async unlinkSession(rootPath: string, ticketId: string): Promise<void> {
      if (!isValidBdTicketId(ticketId)) {
        throw new BdError('unknown', ticketId, 'invalid ticket id');
      }

      // 既にキーが無くても bd は成功終了する(冪等)ので、事前の存在チェックは
      // 不要。誤って別セッションを消す心配もない(キーは1つしか持てない)。
      await runUpdate(commandRunner, bdPath, timeoutMs, rootPath, ticketId, [
        '--unset-metadata',
        SESSION_LINK_METADATA_KEY,
      ]);
    },
  };
}
