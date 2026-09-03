import { z } from 'zod';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import type {
  HumanDecisionsPort,
  PendingDecision,
  PendingDecisionKind,
  PendingDecisionOption,
  RespondOutcome,
} from '../../application/ports/human-decisions.js';
import { BdError } from '../../application/ports/issue-repository.js';
import { classifyBdError } from './classify-bd-error.js';
import { withLockContentionRetry } from './bd-retry.js';

const DEFAULT_BD_PATH = 'bd';
const DEFAULT_TIMEOUT_MS = 30_000;
const GATE_CLOSE_REASON_MAX_LEN = 200;

export type { HumanDecisionsPort, PendingDecision, PendingDecisionOption, RespondOutcome };

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
  issue_type: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const bdShowItemSchema = z.object({
  issue_type: z.string().optional(),
});

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

function buildShowArgs(rootPath: string, issueId: string): readonly string[] {
  return ['--readonly', '-C', rootPath, 'show', issueId, '--json'];
}

function buildGateResponseCommentBody(responseText: string): string {
  return `Response: ${responseText}`;
}

function buildTicketResponseCommentBody(responseText: string): string {
  return `${buildGateResponseCommentBody(responseText)}

(bdboard: 確認待ちへの回答として記録しました。作業チケットのため close せず、human ラベルのみ解除しています。)`;
}

function buildResponseCommentBody(
  responseText: string,
  kind: PendingDecisionKind,
): string {
  return kind === 'gate'
    ? buildGateResponseCommentBody(responseText)
    : buildTicketResponseCommentBody(responseText);
}

function buildAddResponseCommentArgs(
  rootPath: string,
  issueId: string,
  responseText: string,
  kind: PendingDecisionKind,
): readonly string[] {
  return [
    '-C',
    rootPath,
    'comment',
    issueId,
    buildResponseCommentBody(responseText, kind),
  ];
}

function normalizeResponseTextForCloseReason(responseText: string): string {
  return responseText.replace(/\s+/g, ' ').trim();
}

function buildGateCloseReason(responseText: string): string {
  const normalized = normalizeResponseTextForCloseReason(responseText);
  if (normalized.length === 0) {
    return 'Responded';
  }

  const truncated =
    normalized.length > GATE_CLOSE_REASON_MAX_LEN
      ? `${normalized.slice(0, GATE_CLOSE_REASON_MAX_LEN)}…`
      : normalized;

  return `Responded: ${truncated}`;
}

function buildCloseRespondedIssueArgs(
  rootPath: string,
  issueId: string,
  responseText: string,
): readonly string[] {
  return [
    '-C',
    rootPath,
    'close',
    issueId,
    '--reason',
    buildGateCloseReason(responseText),
  ];
}

function buildRemoveHumanLabelArgs(
  rootPath: string,
  issueId: string,
): readonly string[] {
  return ['-C', rootPath, 'label', 'remove', issueId, 'human'];
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
    kind: raw.issue_type === 'gate' ? 'gate' : 'ticket',
    ...(question !== undefined ? { question } : {}),
    ...(options !== undefined ? { options } : {}),
    allowFreeform,
  };
}

function parseShowStdoutForKind(stdout: string): PendingDecisionKind {
  const trimmedStdout = stdout.trim();
  if (trimmedStdout.length === 0) {
    return 'ticket';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedStdout) as unknown;
  } catch {
    return 'ticket';
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return 'ticket';
  }

  const itemResult = bdShowItemSchema.safeParse(parsed[0]);
  if (!itemResult.success) {
    return 'ticket';
  }

  return itemResult.data.issue_type === 'gate' ? 'gate' : 'ticket';
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

async function resolveKind(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  issueId: string,
): Promise<PendingDecisionKind> {
  try {
    const result = await withLockContentionRetry(async () => {
      const commandResult = await commandRunner.run(
        bdPath,
        buildShowArgs(rootPath, issueId),
        { timeoutMs },
      );

      if (commandResult.exitCode !== 0) {
        const combined = `${commandResult.stdout}\n${commandResult.stderr}`.toLowerCase();
        const errorKind = classifyBdError(commandResult.exitCode, combined);
        if (errorKind === 'lock-contention') {
          throw new BdError(
            errorKind,
            issueId,
            combined.trim() || `exit code ${commandResult.exitCode}`,
          );
        }
        return null;
      }

      return commandResult;
    });

    if (result === null) {
      return 'ticket';
    }

    return parseShowStdoutForKind(result.stdout);
  } catch {
    return 'ticket';
  }
}

export function createBdCliHumanDecisions(
  commandRunner: CommandRunner,
  options?: BdCliHumanDecisionsOptions,
): HumanDecisionsPort {
  const bdPath = options?.bdPath ?? DEFAULT_BD_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    // bd list --readonly は読み取り専用でべき等なので、lock-contention なら
    // 数回まで自動リトライしてよい(bdboard-3tj)。respond() 側の bd comment /
    // bd close / bd label remove はどちらも書き込みで、特に comment は追記系で
    // べき等ではないため(二重投稿のリスク)意図的にリトライ対象から外している。
    async listPendingDecisions(rootPath: string): Promise<readonly PendingDecision[]> {
      const result = await withLockContentionRetry(async () => {
        const commandResult = await commandRunner.run(
          bdPath,
          buildListArgs(rootPath),
          { timeoutMs },
        );

        if (commandResult.exitCode !== 0) {
          const combined = `${commandResult.stdout}\n${commandResult.stderr}`.toLowerCase();
          const kind = classifyBdError(commandResult.exitCode, combined);
          throw new BdError(
            kind,
            rootPath,
            combined.trim() || `exit code ${commandResult.exitCode}`,
          );
        }

        return commandResult;
      });

      return parseListStdout(result.stdout);
    },

    // NOTE(bdboard-3tj): 以下の respond() はリトライ非対応のまま。bd comment は
    // 追記系で呼ぶたびに新しいコメントが増えるためべき等ではなく、bd close も
    // bd label remove も直前の comment 呼び出しとの一貫性のため非リトライにしている
    // (label remove は冪等だが、comment 二重投稿のリスクを避ける)。lock-contention
    // 時にここで自動リトライすると二重実行のリスクがある。手動リトライ(呼び出し元
    // での再実行)に委ねる。
    // bdboard-07d: bd-m7zzd's needsStoreHumanSubcommands exception to
    // noDbCommands regressed between beads v1.2.1 and v1.2.2. Avoid `human
    // respond` until upstream keeps that fix.
    async respond(
      rootPath: string,
      issueId: string,
      responseText: string,
    ): Promise<RespondOutcome> {
      const kind = await resolveKind(
        commandRunner,
        bdPath,
        timeoutMs,
        rootPath,
        issueId,
      );

      const commentResult = await commandRunner.run(
        bdPath,
        buildAddResponseCommentArgs(rootPath, issueId, responseText, kind),
        { timeoutMs },
      );

      if (commentResult.exitCode !== 0) {
        const combined = `${commentResult.stdout}\n${commentResult.stderr}`.toLowerCase();
        const errorKind = classifyBdError(commentResult.exitCode, combined);
        throw new BdError(
          errorKind,
          issueId,
          combined.trim() || `exit code ${commentResult.exitCode}`,
        );
      }

      if (kind === 'gate') {
        const closeResult = await commandRunner.run(
          bdPath,
          buildCloseRespondedIssueArgs(rootPath, issueId, responseText),
          { timeoutMs },
        );

        if (closeResult.exitCode !== 0) {
          const combined = `${closeResult.stdout}\n${closeResult.stderr}`.toLowerCase();
          const errorKind = classifyBdError(closeResult.exitCode, combined);
          throw new BdError(
            errorKind,
            issueId,
            combined.trim() || `exit code ${closeResult.exitCode}`,
          );
        }
      } else {
        const labelResult = await commandRunner.run(
          bdPath,
          buildRemoveHumanLabelArgs(rootPath, issueId),
          { timeoutMs },
        );

        if (labelResult.exitCode !== 0) {
          const combined = `${labelResult.stdout}\n${labelResult.stderr}`.toLowerCase();
          const errorKind = classifyBdError(labelResult.exitCode, combined);
          throw new BdError(
            errorKind,
            issueId,
            combined.trim() || `exit code ${labelResult.exitCode}`,
          );
        }
      }

      return { kind, closed: kind === 'gate' };
    },
  };
}

// Exported for unit tests.
export {
  buildGateCloseReason,
  buildResponseCommentBody,
  buildTicketResponseCommentBody,
};
