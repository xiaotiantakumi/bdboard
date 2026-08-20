import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  HumanDecisionsPort,
  PendingDecision,
  PendingDecisionOption,
} from '../../application/ports/human-decisions.js';
import {
  BdError,
  type BdErrorKind,
} from '../../application/ports/issue-repository.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;

export type { HumanDecisionsPort, PendingDecision, PendingDecisionOption };

export interface BdCliHumanDecisionsOptions {
  readonly bdPath?: string;
  readonly timeoutMs?: number;
}

const decisionOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const bdHumanListItemSchema = z.object({
  id: z.string(),
  metadata: z.record(z.unknown()).optional(),
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
    '-l',
    'human',
    '--json',
    '--limit',
    '0',
    '--no-pager',
  ];
}

function buildAddResponseCommentArgs(
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] {
  // bdboard-07d: bd-m7zzd's needsStoreHumanSubcommands exception to
  // noDbCommands regressed between beads v1.2.1 and v1.2.2. Avoid `human
  // respond` until upstream keeps that fix.
  return [
    '-C',
    rootPath,
    'comment',
    issueId,
    `Response: ${responseText}`,
  ];
}

function buildCloseRespondedIssueArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return ['-C', rootPath, 'close', issueId, '--reason', 'Responded'];
}

function parseAllowFreeform(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return true;
}

function parseDecisionOptions(
  value: unknown,
): readonly PendingDecisionOption[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  const options: PendingDecisionOption[] = [];
  for (const entry of parsed) {
    const result = decisionOptionSchema.safeParse(entry);
    if (result.success) {
      options.push(result.data);
    }
  }

  if (options.length === 0) {
    return undefined;
  }

  return options;
}

function mapListItemToPendingDecision(
  raw: z.infer<typeof bdHumanListItemSchema>,
): PendingDecision | undefined {
  const metadata = raw.metadata;
  const question =
    metadata !== undefined &&
    typeof metadata.decision_question === 'string' &&
    metadata.decision_question.length > 0
      ? metadata.decision_question
      : undefined;

  const options =
    metadata !== undefined
      ? parseDecisionOptions(metadata.decision_options)
      : undefined;

  const allowFreeform =
    metadata !== undefined
      ? parseAllowFreeform(metadata.decision_allow_freeform)
      : true;

  return {
    id: raw.id,
    ...(question !== undefined ? { question } : {}),
    ...(options !== undefined ? { options } : {}),
    allowFreeform,
  };
}

function parseListStdout(stdout: string): readonly PendingDecision[] {
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

  if (!Array.isArray(parsed)) {
    return [];
  }

  const decisions: PendingDecision[] = [];
  for (const rawItem of parsed) {
    const itemResult = bdHumanListItemSchema.safeParse(rawItem);
    if (!itemResult.success) {
      // Skip only the malformed entry so one bad ticket doesn't hide the rest.
      continue;
    }

    const mapped = mapListItemToPendingDecision(itemResult.data);
    if (mapped !== undefined) {
      decisions.push(mapped);
    }
  }

  return decisions;
}

export function createBdCliHumanDecisions(
  commandRunner: CommandRunner,
  options?: BdCliHumanDecisionsOptions,
): HumanDecisionsPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async listPendingDecisions(rootPath: string): Promise<readonly PendingDecision[]> {
      const result = await commandRunner.run(
        bdPath,
        buildListArgs(rootPath),
        { timeoutMs },
      );

      if (result.exitCode !== 0) {
        const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
        const kind = classifyBdError(result.exitCode, combined);
        throw new BdError(
          kind,
          rootPath,
          combined.trim() || `exit code ${result.exitCode}`,
        );
      }

      return parseListStdout(result.stdout);
    },

    async respond(
      rootPath: string,
      issueId: string,
      responseText: string,
    ): Promise<void> {
      const commentResult = await commandRunner.run(
        bdPath,
        buildAddResponseCommentArgs(rootPath, issueId, responseText),
        { timeoutMs },
      );

      if (commentResult.exitCode !== 0) {
        const combined = `${commentResult.stdout}\n${commentResult.stderr}`.toLowerCase();
        const kind = classifyBdError(commentResult.exitCode, combined);
        throw new BdError(
          kind,
          issueId,
          combined.trim() || `exit code ${commentResult.exitCode}`,
        );
      }

      const closeResult = await commandRunner.run(
        bdPath,
        buildCloseRespondedIssueArgs(rootPath, issueId),
        { timeoutMs },
      );

      if (closeResult.exitCode !== 0) {
        const combined = `${closeResult.stdout}\n${closeResult.stderr}`.toLowerCase();
        const kind = classifyBdError(closeResult.exitCode, combined);
        throw new BdError(
          kind,
          issueId,
          combined.trim() || `exit code ${closeResult.exitCode}`,
        );
      }
    },
  };
}
