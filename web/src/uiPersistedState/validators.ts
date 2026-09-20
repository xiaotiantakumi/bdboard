// bdboard-sso1.26: web/src/uiPersistedState.ts から move-only で分割。
// 挙動・型は変えていない (移動のみ)。
import { LANES, type Lane } from '../api';

export const BOARD_ISSUE_TYPES = ['bug', 'feature', 'task', 'chore', 'epic'] as const;

export function validateIssueTypeArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  const allowed = new Set<string>(BOARD_ISSUE_TYPES);
  if (!value.every((item) => allowed.has(item))) {
    return null;
  }
  return value;
}

export function validateLaneArray(value: unknown): Lane[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  const allowed = new Set<string>(LANES);
  if (!value.every((item) => allowed.has(item))) {
    return null;
  }
  return value as Lane[];
}

export function validateStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  if (!value.every((item) => typeof item === 'string')) {
    return null;
  }
  return value;
}

export function validateWatchedTicketIds(value: unknown): string[] | null {
  const ids = validateStringArray(value);
  if (ids === null) {
    return null;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) {
      return null;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function validateChatModelSelections(
  value: unknown,
): Record<string, Record<string, string>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (
    !entries.every(([projectId, agentMap]) => {
      if (typeof projectId !== 'string') {
        return false;
      }
      if (agentMap === null || typeof agentMap !== 'object' || Array.isArray(agentMap)) {
        return false;
      }
      return Object.entries(agentMap).every(
        ([agentId, modelId]) => typeof agentId === 'string' && typeof modelId === 'string',
      );
    })
  ) {
    return null;
  }
  return value as Record<string, Record<string, string>>;
}

export function validateBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  return null;
}

export function validateString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}
