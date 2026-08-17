import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  InProgressWithLease,
  LeaseReader,
} from '../../application/ports/lease-reader.js';
import {
  BdError,
  type BdErrorKind,
} from '../../application/ports/issue-repository.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliLeaseReaderOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

const bdInProgressItemSchema = z.object({
  id: z.string(),
  lease_expires_at: z.string().nullable().optional(),
  heartbeat_at: z.string().nullable().optional(),
});

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
  };
}

export function createBdCliLeaseReader(
  commandRunner: CommandRunner,
  options?: BdCliLeaseReaderOptions,
): LeaseReader {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async listInProgressWithLease(projectRootPath: string): Promise<readonly InProgressWithLease[]> {
      const commandResult = await commandRunner.run(
        bdPath,
        buildListArgs(projectRootPath),
        { timeoutMs },
      );

      if (commandResult.exitCode !== 0) {
        const combined = `${commandResult.stdout}\n${commandResult.stderr}`.toLowerCase();
        const kind = classifyBdError(commandResult.exitCode, combined);
        throw new BdError(
          kind,
          projectRootPath,
          combined.trim() || `exit code ${commandResult.exitCode}`,
        );
      }

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
