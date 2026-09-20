// bd-cli-human-decisions.ts (bdboard-sso1.16) の分割で切り出した、pending decisions の
// bd CLI stdout (bd list / bd gate list の --json 出力) パース担当。read.ts (list 実行と
// 引数組み立て)からだけ使う内部モジュール。挙動・型は分割前と同一(移動のみ)。
import { z } from 'zod';
import type {
  PendingDecision,
  PendingDecisionKind,
  PendingDecisionOption,
} from '../../../application/ports/human-decisions.js';

const decisionOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const bdHumanListItemSchema = z.object({
  id: z.string(),
  issue_type: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// e2e fixture の契約テスト (e2e-fixtures-contract.test.ts, bdboard-0rch) から参照するため export する。
export const bdGateListItemSchema = z.object({
  id: z.string(),
  issue_type: z.string().optional(),
  await_type: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

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
  kindOverride?: PendingDecisionKind,
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

  const kind =
    kindOverride ??
    (raw.issue_type === 'gate' ? 'gate' : 'ticket');

  return {
    id: raw.id,
    kind,
    ...(question !== undefined ? { question } : {}),
    ...(options !== undefined ? { options } : {}),
    allowFreeform,
  };
}

export function parseListStdout(stdout: string): readonly PendingDecision[] {
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

export function parseGateListStdout(stdout: string): readonly PendingDecision[] {
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
    const itemResult = bdGateListItemSchema.safeParse(rawItem);
    if (!itemResult.success) {
      // Skip only the malformed entry so one bad gate doesn't hide the rest.
      continue;
    }

    const { issue_type, await_type } = itemResult.data;
    if (issue_type !== 'gate' || await_type !== 'human') {
      continue;
    }

    const mapped = mapListItemToPendingDecision(itemResult.data, 'gate');
    if (mapped !== undefined) {
      decisions.push(mapped);
    }
  }

  return decisions;
}

export function mergePendingDecisions(
  labelDecisions: readonly PendingDecision[],
  gateDecisions: readonly PendingDecision[],
): readonly PendingDecision[] {
  const byId = new Map<string, PendingDecision>();
  const labelOrder: string[] = [];

  for (const decision of labelDecisions) {
    byId.set(decision.id, decision);
    labelOrder.push(decision.id);
  }

  const newGateIds: string[] = [];
  for (const gate of gateDecisions) {
    const existing = byId.get(gate.id);
    if (existing !== undefined) {
      // metadata を持っている label 由来の question/options/allowFreeform を保ちつつ
      // kind だけ gate に上書きする。
      byId.set(gate.id, { ...existing, kind: 'gate' });
    } else {
      byId.set(gate.id, gate);
      newGateIds.push(gate.id);
    }
  }

  const merged: PendingDecision[] = [];
  for (const id of labelOrder) {
    const decision = byId.get(id);
    if (decision !== undefined) {
      merged.push(decision);
    }
  }
  for (const id of newGateIds) {
    const decision = byId.get(id);
    if (decision !== undefined) {
      merged.push(decision);
    }
  }

  return merged;
}
