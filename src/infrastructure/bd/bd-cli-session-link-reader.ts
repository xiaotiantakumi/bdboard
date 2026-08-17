import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  SessionLinkReaderPort,
  TicketBdMetadata,
} from '../../application/ports/session-link-reader.js';
import { isValidBdTicketId } from '../../domain/chat.js';
import { parseTicketModelRecords } from '../../domain/ticket-model.js';
import { SESSION_LINK_METADATA_KEY } from './bd-cli-session-link-writer.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliSessionLinkReaderOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

const bdShowItemSchema = z.object({
  id: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

const EMPTY_METADATA: TicketBdMetadata = { models: [] };

function parseTicketBdMetadata(stdout: string): TicketBdMetadata {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return EMPTY_METADATA;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return EMPTY_METADATA;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return EMPTY_METADATA;
  }

  const result = bdShowItemSchema.safeParse(parsed[0]);
  if (!result.success) {
    return EMPTY_METADATA;
  }

  const sessionValue = result.data.metadata?.[SESSION_LINK_METADATA_KEY];
  const manualSessionId =
    typeof sessionValue === 'string' && sessionValue.length > 0
      ? sessionValue
      : undefined;

  const models = parseTicketModelRecords(result.data.metadata);

  return {
    ...(manualSessionId !== undefined ? { manualSessionId } : {}),
    models,
  };
}

/**
 * `bd show --json` を読み取り専用で叩いて `bdboard.session` メタデータと
 * `bdboard.model.*` メタデータを取り出す。チケット未発見・bd失敗・パース失敗は
 * いずれも `{ models: [] }` に落とす — これは表示専用の補助データであり、
 * チケット詳細全体の取得を失敗させるべきではないため(呼び出し側での
 * best-effort扱いを前提にする)。
 */
export function createBdCliSessionLinkReader(
  commandRunner: CommandRunner,
  options?: BdCliSessionLinkReaderOptions,
): SessionLinkReaderPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async readTicketMetadata(
      rootPath: string,
      ticketId: string,
    ): Promise<TicketBdMetadata> {
      if (!isValidBdTicketId(ticketId)) {
        return EMPTY_METADATA;
      }

      const result = await commandRunner.run(
        bdPath,
        ['--readonly', '-C', rootPath, 'show', '--json', `--id=${ticketId}`],
        { cwd: rootPath, timeoutMs },
      );

      if (result.exitCode !== 0) {
        return EMPTY_METADATA;
      }

      return parseTicketBdMetadata(result.stdout);
    },
  };
}
