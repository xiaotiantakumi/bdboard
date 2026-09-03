import { runWithConcurrencyLimit } from '../../application/concurrency.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import {
  BdError,
  type IssueRepository,
  type ProjectTickets,
} from '../../application/ports/issue-repository.js';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { classifyBdError } from './classify-bd-error.js';
import { withLockContentionRetry } from './bd-retry.js';
import { collectPrefixes, mapBdListToTickets } from './bd-issue-mapper.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;

export interface BdCliOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

function buildListArgs(rootPath: string): readonly string[] {
  // gate bead は既定の bd list では隠れる。カードとして載せないと確認待ちの回答 UI
  // が開けない(bdboard-bh48)。
  return [
    '--readonly',
    '-C',
    rootPath,
    'list',
    '--json',
    '--all',
    '--limit',
    '0',
    '--no-pager',
    '--include-gates',
  ];
}

function buildSkippedWarning(
  projectId: string,
  skipped: readonly { readonly index: number; readonly id?: string; readonly detail: string }[],
): BdError {
  const summaries = skipped.slice(0, 3).map((entry) => {
    const idPart = entry.id !== undefined ? `${entry.id}: ` : '';
    return `${idPart}${entry.detail}`;
  });
  const detail = `${skipped.length}件のチケットを読み飛ばしました: ${summaries.join('; ')}`;
  return new BdError('schema-mismatch', projectId, detail);
}

export function createBdCliIssueRepository(
  commandRunner: CommandRunner,
  options?: BdCliOptions,
): IssueRepository {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;

  // bd list --readonly は読み取り専用でべき等なので、lock-contention
  // (embedded doltのflock競合)なら数回まで自動リトライしてよい(bdboard-3tj)。
  async function listTickets(project: Project): Promise<ProjectTickets> {
    const commandResult = await withLockContentionRetry(async () => {
      const result = await commandRunner.run(bdPath, buildListArgs(project.rootPath), {
        timeoutMs,
      });

      if (result.exitCode !== 0) {
        const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
        const kind = classifyBdError(result.exitCode, combined);
        throw new BdError(kind, project.id, combined.trim() || `exit code ${result.exitCode}`);
      }

      return result;
    });

    const trimmedStdout = commandResult.stdout.trim();
    if (trimmedStdout.length === 0) {
      throw new BdError('schema-mismatch', project.id, 'empty stdout');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedStdout) as unknown;
    } catch {
      throw new BdError('schema-mismatch', project.id, 'invalid JSON in stdout');
    }

    const { tickets, skipped } = mapBdListToTickets(parsed, project.id);
    const prefixes = collectPrefixes(tickets);

    const result: ProjectTickets = {
      project: { ...project, prefixes },
      tickets,
    };

    if (skipped.length > 0) {
      return {
        ...result,
        warnings: [buildSkippedWarning(project.id, skipped)],
      };
    }

    return result;
  }

  return {
    listTickets,

    async listAll(projects: readonly Project[]): Promise<{
      readonly results: readonly ProjectTickets[];
      readonly errors: readonly BdError[];
    }> {
      const results: ProjectTickets[] = [];
      const errors: BdError[] = [];

      await runWithConcurrencyLimit(projects, concurrency, async (project) => {
        try {
          const projectTickets = await listTickets(project);
          results.push(projectTickets);
          if (projectTickets.warnings !== undefined) {
            errors.push(...projectTickets.warnings);
          }
        } catch (error: unknown) {
          if (error instanceof BdError) {
            errors.push(error);
          } else {
            const detail = error instanceof Error ? error.message : String(error);
            errors.push(new BdError('unknown', project.id, detail));
          }
        }
      });

      results.sort((a, b) => compareStrings(a.project.rootPath, b.project.rootPath));
      errors.sort((a, b) => compareStrings(a.projectId, b.projectId));

      return { results, errors };
    },
  };
}
