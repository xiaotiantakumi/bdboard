import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  MergeSlotReader,
  MergeSlotSignal,
} from '../../application/ports/merge-slot-reader.js';
import {
  BdError,
  type BdErrorKind,
} from '../../application/ports/issue-repository.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliMergeSlotReaderOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

const bdMergeSlotItemSchema = z.object({
  id: z.string(),
  status: z.string(),
  updated_at: z.string(),
  metadata: z.object({ holder: z.string().optional() }).partial().optional(),
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
    '--label',
    'gt:slot',
    '--json',
    '--limit',
    '0',
    '--no-pager',
  ];
}

function mapItem(raw: z.infer<typeof bdMergeSlotItemSchema>): MergeSlotSignal {
  return {
    status: raw.status,
    holder: raw.metadata?.holder ?? null,
    updatedAt: raw.updated_at,
  };
}

export function createBdCliMergeSlotReader(
  commandRunner: CommandRunner,
  options?: BdCliMergeSlotReaderOptions,
): MergeSlotReader {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async readMergeSlotSignal(projectRootPath: string): Promise<MergeSlotSignal | null> {
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
        return null;
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

      if (parsed.length === 0) {
        return null;
      }

      const result = bdMergeSlotItemSchema.safeParse(parsed[0]);
      if (!result.success) {
        throw new BdError('schema-mismatch', projectRootPath, 'unexpected list item shape');
      }

      return mapItem(result.data);
    },
  };
}
