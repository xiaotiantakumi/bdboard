import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import {
  BdError,
  type BdErrorKind,
} from '../../application/ports/issue-repository.js';
import type { IssueComment } from '../../domain/issue-comment.js';
import type { TicketId } from '../../domain/ticket-id.js';
import { bdCommentListSchema, type BdComment } from './bd-issue-schema.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BdCliCommentReaderOptions {
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

function buildCommentsArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return ['--readonly', '-C', rootPath, 'comments', issueId, '--json'];
}

function parseRequiredDate(value: string, field: string, issueId: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BdError(
      'schema-mismatch',
      issueId,
      `invalid date in ${field}: ${value}`,
    );
  }
  return date;
}

function mapBdCommentToIssueComment(raw: BdComment): IssueComment {
  return {
    id: raw.id,
    issueId: raw.issue_id as TicketId,
    author: raw.author,
    text: raw.text,
    createdAt: parseRequiredDate(raw.created_at, 'created_at', raw.issue_id),
  };
}

function parseCommentsStdout(stdout: string): readonly IssueComment[] {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedStdout) as unknown;
  } catch {
    return [];
  }

  const result = bdCommentListSchema.safeParse(parsed);
  if (!result.success) {
    return [];
  }

  return result.data
    .map(mapBdCommentToIssueComment)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export function createBdCliCommentReader(
  commandRunner: CommandRunner,
  options?: BdCliCommentReaderOptions,
): CommentReader {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async listComments(
      rootPath: string,
      issueId: TicketId,
    ): Promise<readonly IssueComment[]> {
      const result = await commandRunner.run(
        bdPath,
        buildCommentsArgs(rootPath, issueId),
        { timeoutMs },
      );

      if (result.exitCode !== 0) {
        const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
        const kind = classifyBdError(result.exitCode, combined);
        throw new BdError(
          kind,
          issueId,
          combined.trim() || `exit code ${result.exitCode}`,
        );
      }

      return parseCommentsStdout(result.stdout);
    },
  };
}
