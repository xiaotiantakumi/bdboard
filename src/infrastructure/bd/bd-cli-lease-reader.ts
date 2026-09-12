import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  InProgressWithLease,
  LeaseReader,
} from '../../application/ports/lease-reader.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { classifyBdError } from './classify-bd-error.js';
import { withLockContentionRetry } from './bd-retry.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliLeaseReaderOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

// e2e fixture の契約テスト (e2e-fixtures-contract.test.ts, bdboard-0rch) から参照するため export する。
export const bdInProgressItemSchema = z.object({
  id: z.string(),
  lease_expires_at: z.string().nullable().optional(),
  heartbeat_at: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  // 実 bd では全チケットに付くが、ここで必須にしない。この reader は Hygiene の
  // 失効 lease 一覧 (get-stale-lease-issues) も支えているので、1 件でも欠けると
  // 一覧ごと黙って空になる (e2e の lease fixture で実際に起きた)。欠けたら null にし、
  // reclaim 側は保護起点を「今」にフォールバックする (plan-project-reclaim.ts)。
  created_at: z.string().nullable().optional(),
});

function buildListArgs(rootPath: string): readonly string[] {
  return [
    '--readonly',
    '-C',
    rootPath,
    'list',
    '--status',
    'in_progress',
    '--json',
    '--limit',
    '0',
    '--no-pager',
  ];
}

function mapItem(raw: z.infer<typeof bdInProgressItemSchema>): InProgressWithLease {
  return {
    id: raw.id,
    leaseExpiresAt: raw.lease_expires_at ?? null,
    heartbeatAt: raw.heartbeat_at ?? null,
    startedAt: raw.started_at ?? null,
    createdAt: raw.created_at ?? null,
  };
}

export function createBdCliLeaseReader(
  commandRunner: CommandRunner,
  options?: BdCliLeaseReaderOptions,
): LeaseReader {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    // bd list --readonly は読み取り専用でべき等なので、lock-contention
    // なら数回まで自動リトライしてよい(bdboard-3tj)。
    async listInProgressWithLease(projectRootPath: string): Promise<readonly InProgressWithLease[]> {
      const commandResult = await withLockContentionRetry(async () => {
        const result = await commandRunner.run(
          bdPath,
          buildListArgs(projectRootPath),
          { timeoutMs },
        );

        if (result.exitCode !== 0) {
          const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
          const kind = classifyBdError(result.exitCode, combined);
          throw new BdError(
            kind,
            projectRootPath,
            combined.trim() || `exit code ${result.exitCode}`,
          );
        }

        return result;
      });

      const trimmedStdout = commandResult.stdout.trim();
      if (trimmedStdout.length === 0) {
        return [];
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmedStdout) as unknown;
      } catch {
        throw new BdError('schema-mismatch', projectRootPath, 'invalid JSON in stdout');
      }

      if (!Array.isArray(parsed)) {
        throw new BdError('schema-mismatch', projectRootPath, 'expected JSON array');
      }

      const items: InProgressWithLease[] = [];
      for (const entry of parsed) {
        const result = bdInProgressItemSchema.safeParse(entry);
        if (!result.success) {
          throw new BdError('schema-mismatch', projectRootPath, 'unexpected list item shape');
        }
        items.push(mapItem(result.data));
      }

      return items;
    },
  };
}
