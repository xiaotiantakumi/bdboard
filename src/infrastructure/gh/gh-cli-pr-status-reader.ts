import { z } from 'zod';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type {
  PrStatusFailureReason,
  PrStatusReader,
  PrStatusResult,
} from '../../application/ports/pr-status-reader.js';
import type { PrCheckStatus, PrState, PrStatus } from '../../domain/pr-link.js';

const DEFAULT_GH_PATH = 'gh';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface GhCliPrStatusReaderOptions {
  readonly ghPath?: string;
  readonly timeoutMs?: number;
}

const rollupItemSchema = z
  .object({
    __typename: z.string().optional(),
    status: z.string().optional(),
    conclusion: z.string().nullable().optional(),
    state: z.string().optional(),
  })
  .passthrough();

const ghPrViewSchema = z
  .object({
    state: z.string().optional(),
    statusCheckRollup: z.array(rollupItemSchema).nullable().optional(),
  })
  .passthrough();

const CHECK_RUN_FAIL_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
]);

const STATUS_CONTEXT_FAIL_STATES = new Set(['FAILURE', 'ERROR']);

const STATUS_CONTEXT_PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

// gh の失敗メッセージ文言 (bdboard-7ln6 #1)。GraphQL/REST どちらの経路でも
// 「rate limit」という語自体は共通して出てくる。HTTP 403/429 も rate limit
// として扱う (gh は "(HTTP 403)" / "(HTTP 429)" のように末尾に付記する)。
const RATE_LIMIT_TEXT_PATTERNS = [
  /api rate limit/i,
  /rate limit exceeded/i,
  /secondary rate limit/i,
];
const RATE_LIMIT_HTTP_STATUS_PATTERN = /\bHTTP\s+(403|429)\b/i;
const NOT_FOUND_TEXT_PATTERNS = [
  /could not resolve/i,
  /no pull requests found/i,
  /\bnot found\b/i,
];

function looksLikeRateLimit(text: string): boolean {
  return (
    RATE_LIMIT_TEXT_PATTERNS.some((pattern) => pattern.test(text)) ||
    RATE_LIMIT_HTTP_STATUS_PATTERN.test(text)
  );
}

function looksLikeNotFound(text: string): boolean {
  return NOT_FOUND_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

/** commandRunner.run の結果から失敗理由を分類する (exitCode!==0 のとき呼ぶ)。 */
function classifyCommandFailure(commandResult: CommandResult): PrStatusFailureReason {
  if (commandResult.failureKind === 'timeout') {
    return 'timeout';
  }
  const combined = `${commandResult.stderr}\n${commandResult.stdout}`;
  if (looksLikeRateLimit(combined)) {
    return 'rate-limit';
  }
  if (looksLikeNotFound(combined)) {
    return 'not-found';
  }
  return 'other';
}

/** commandRunner.run 自体が例外を投げた場合の分類。 */
function classifyThrown(error: unknown): PrStatusFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (looksLikeRateLimit(message)) {
    return 'rate-limit';
  }
  return 'other';
}

function mapPrState(raw: string | undefined): PrState {
  const upper = raw?.toUpperCase();
  if (upper === 'MERGED') {
    return 'merged';
  }
  if (upper === 'CLOSED') {
    return 'closed';
  }
  if (upper === 'OPEN') {
    return 'open';
  }
  return 'open';
}

function isFailItem(item: z.infer<typeof rollupItemSchema>): boolean {
  if (item.__typename === 'CheckRun' || item.conclusion !== undefined) {
    const conclusion = item.conclusion?.toUpperCase();
    return conclusion !== undefined && CHECK_RUN_FAIL_CONCLUSIONS.has(conclusion);
  }
  if (item.__typename === 'StatusContext' || item.state !== undefined) {
    const state = item.state?.toUpperCase();
    return state !== undefined && STATUS_CONTEXT_FAIL_STATES.has(state);
  }
  return false;
}

function isPendingItem(item: z.infer<typeof rollupItemSchema>): boolean {
  if (item.__typename === 'CheckRun' || item.status !== undefined) {
    const status = item.status?.toUpperCase();
    return status !== undefined && status !== 'COMPLETED';
  }
  if (item.__typename === 'StatusContext' || item.state !== undefined) {
    const state = item.state?.toUpperCase();
    return state !== undefined && STATUS_CONTEXT_PENDING_STATES.has(state);
  }
  return false;
}

function deriveCheckStatus(
  rollup: readonly z.infer<typeof rollupItemSchema>[] | null | undefined,
): PrCheckStatus {
  if (rollup === null || rollup === undefined || rollup.length === 0) {
    return 'unknown';
  }

  for (const item of rollup) {
    if (isFailItem(item)) {
      return 'fail';
    }
  }

  for (const item of rollup) {
    if (isPendingItem(item)) {
      return 'pending';
    }
  }

  return 'pass';
}

function failure(reason: PrStatusFailureReason): PrStatusResult {
  return { status: null, reason };
}

export function createGhCliPrStatusReader(
  commandRunner: CommandRunner,
  options?: GhCliPrStatusReaderOptions,
): PrStatusReader {
  const ghPath = options?.ghPath ?? DEFAULT_GH_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async getPrStatus(prUrl: string): Promise<PrStatusResult> {
      let commandResult: CommandResult;
      try {
        commandResult = await commandRunner.run(
          ghPath,
          ['pr', 'view', prUrl, '--json', 'state,statusCheckRollup'],
          { timeoutMs },
        );
      } catch (error) {
        return failure(classifyThrown(error));
      }

      if (commandResult.exitCode !== 0) {
        return failure(classifyCommandFailure(commandResult));
      }

      const trimmedStdout = commandResult.stdout.trim();
      if (trimmedStdout.length === 0) {
        return failure('other');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedStdout) as unknown;
      } catch {
        return failure('other');
      }

      const result = ghPrViewSchema.safeParse(parsed);
      if (!result.success) {
        return failure('other');
      }

      const status: PrStatus = {
        state: mapPrState(result.data.state),
        checkStatus: deriveCheckStatus(result.data.statusCheckRollup),
      };
      return { status };
    },
  };
}
