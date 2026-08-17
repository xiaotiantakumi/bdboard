import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
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

export function createGhCliPrStatusReader(
  commandRunner: CommandRunner,
  options?: GhCliPrStatusReaderOptions,
): PrStatusReader {
  const ghPath = options?.ghPath ?? DEFAULT_GH_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async getPrStatus(prUrl: string): Promise<PrStatus | null> {
      try {
        const commandResult = await commandRunner.run(
          ghPath,
          ['pr', 'view', prUrl, '--json', 'state,statusCheckRollup'],
          { timeoutMs },
        );

        if (commandResult.exitCode !== 0) {
          return null;
        }

        const trimmedStdout = commandResult.stdout.trim();
        if (trimmedStdout.length === 0) {
          return null;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmedStdout) as unknown;
        } catch {
          return null;
        }

        const result = ghPrViewSchema.safeParse(parsed);
        if (!result.success) {
          return null;
        }

        return {
          state: mapPrState(result.data.state),
          checkStatus: deriveCheckStatus(result.data.statusCheckRollup),
        };
      } catch {
        return null;
      }
    },
  };
}
