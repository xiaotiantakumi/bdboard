import type { CommandRunner } from '../../application/ports/command-runner.js';
import {
  BdError,
  type BdErrorKind,
  type IssueRepository,
  type ProjectTickets,
} from '../../application/ports/issue-repository.js';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { collectPrefixes, mapBdListToTickets } from './bd-issue-mapper.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;

export interface BdCliOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

function classifyBdError(
  exitCode: number,
  combinedOutput: string,
): BdErrorKind {
  // NOTE: "not a beads project" must be checked BEFORE the bd-not-found branch,
  // because bd phrases that error as ".beads not found" and the generic
  // 'not found' substring would otherwise swallow it.
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
  return ['--readonly', '-C', rootPath, 'list', '--json', '--all', '--limit', '0', '--no-pager'];
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

async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => {
      executing.delete(task);
    });
    executing.add(task);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

export function createBdCliIssueRepository(
  commandRunner: CommandRunner,
  options?: BdCliOptions,
): IssueRepository {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;

  async function listTickets(project: Project): Promise<ProjectTickets> {
    const commandResult = await commandRunner.run(bdPath, buildListArgs(project.rootPath), {
      timeoutMs,
    });

    if (commandResult.exitCode !== 0) {
      const combined = `${commandResult.stdout}\n${commandResult.stderr}`.toLowerCase();
      const kind = classifyBdError(commandResult.exitCode, combined);
      throw new BdError(kind, project.id, combined.trim() || `exit code ${commandResult.exitCode}`);
    }

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
