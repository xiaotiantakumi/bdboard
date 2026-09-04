import { PRIORITIES } from './status.js';

export interface HygieneThresholds {
  /**
   * 既定 7日。
   *
   * stalled（24時間・セッション無し）とは別軸で、「in_progress のまま長期間経過」を
   * 台帳の腐りとして拾う。startedAt があればそこから、無ければ updatedAt から測る。
   */
  readonly staleInProgressAfterMs: number;
  /** P0/P1 を高優先とみなす上限（この値以下） */
  readonly highPriorityMax: number;
  /**
   * 既定 3日。確認待ち (pending decision) がこの期間を超えて放置されたときの検知閾値。
   * 検知は `src/domain/hygiene.ts` の `checkStalePendingDecision` が担い、
   * この値を直接参照する。
   */
  readonly stalePendingDecisionAfterMs: number;
  /**
   * 既定 7日。close 済みチケットのうち、この期間内に close されたものだけを
   * PR/検証の記録有無のチェック対象にする。古い close まで遡ると台帳全体が
   * 警告で埋まるため、直近だけを見る。
   */
  readonly closedWithoutEvidenceWindowMs: number;
}

export const DEFAULT_HYGIENE_THRESHOLDS: HygieneThresholds = {
  staleInProgressAfterMs: 7 * 24 * 60 * 60_000,
  highPriorityMax: 1,
  stalePendingDecisionAfterMs: 3 * 24 * 60 * 60_000,
  closedWithoutEvidenceWindowMs: 7 * 24 * 60 * 60_000,
};

export interface HygieneThresholdsOverrides {
  readonly staleInProgressAfterMs?: number;
  readonly highPriorityMax?: number;
  readonly stalePendingDecisionAfterMs?: number;
  readonly closedWithoutEvidenceWindowMs?: number;
}

/** 1秒未満は実用上意味がないため下限とする。 */
export const HYGIENE_THRESHOLDS_MIN_MS = 1_000;

/** 日数ベースの閾値は UI 破綻を防ぐ穏当な30日上限。 */
export const HYGIENE_THRESHOLDS_MAX_MS = 30 * 24 * 60 * 60_000;

export const HYGIENE_HIGH_PRIORITY_MIN = PRIORITIES[0]!;
export const HYGIENE_HIGH_PRIORITY_MAX = PRIORITIES[PRIORITIES.length - 1]!;

const FIELD_LIMITS: Record<
  keyof HygieneThresholdsOverrides,
  { min: number; max: number; label: string; kind: 'ms' | 'priority' }
> = {
  staleInProgressAfterMs: {
    min: HYGIENE_THRESHOLDS_MIN_MS,
    max: HYGIENE_THRESHOLDS_MAX_MS,
    label: 'in_progress 放置',
    kind: 'ms',
  },
  stalePendingDecisionAfterMs: {
    min: HYGIENE_THRESHOLDS_MIN_MS,
    max: HYGIENE_THRESHOLDS_MAX_MS,
    label: '確認待ち放置',
    kind: 'ms',
  },
  closedWithoutEvidenceWindowMs: {
    min: HYGIENE_THRESHOLDS_MIN_MS,
    max: HYGIENE_THRESHOLDS_MAX_MS,
    label: 'close 証拠チェック期間',
    kind: 'ms',
  },
  highPriorityMax: {
    min: HYGIENE_HIGH_PRIORITY_MIN,
    max: HYGIENE_HIGH_PRIORITY_MAX,
    label: '高優先度上限',
    kind: 'priority',
  },
};

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function resolveHygieneThresholds(
  overrides?: HygieneThresholdsOverrides,
): HygieneThresholds {
  return {
    staleInProgressAfterMs:
      overrides?.staleInProgressAfterMs ??
      DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs,
    highPriorityMax:
      overrides?.highPriorityMax ?? DEFAULT_HYGIENE_THRESHOLDS.highPriorityMax,
    stalePendingDecisionAfterMs:
      overrides?.stalePendingDecisionAfterMs ??
      DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs,
    closedWithoutEvidenceWindowMs:
      overrides?.closedWithoutEvidenceWindowMs ??
      DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs,
  };
}

export function validateHygieneThresholds(
  overrides: HygieneThresholdsOverrides,
): { ok: boolean; errors: readonly string[] } {
  const errors: string[] = [];

  for (const [key, limits] of Object.entries(FIELD_LIMITS) as [
    keyof HygieneThresholdsOverrides,
    (typeof FIELD_LIMITS)[keyof HygieneThresholdsOverrides],
  ][]) {
    const value = overrides[key];
    if (value === undefined) {
      continue;
    }
    if (!Number.isInteger(value)) {
      errors.push(`${limits.label}は整数で指定してください`);
      continue;
    }
    if (limits.kind === 'ms' && !isPositiveInteger(value)) {
      errors.push(`${limits.label}は正の整数で指定してください`);
      continue;
    }
    if (value < limits.min) {
      errors.push(`${limits.label}は${limits.min}${limits.kind === 'ms' ? 'ミリ秒' : ''}以上にしてください`);
      continue;
    }
    if (value > limits.max) {
      errors.push(`${limits.label}は${limits.max}${limits.kind === 'ms' ? 'ミリ秒' : ''}以下にしてください`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export const DEFAULT_HYGIENE_THRESHOLDS_OVERRIDES: HygieneThresholdsOverrides = {
  staleInProgressAfterMs: DEFAULT_HYGIENE_THRESHOLDS.staleInProgressAfterMs,
  highPriorityMax: DEFAULT_HYGIENE_THRESHOLDS.highPriorityMax,
  stalePendingDecisionAfterMs: DEFAULT_HYGIENE_THRESHOLDS.stalePendingDecisionAfterMs,
  closedWithoutEvidenceWindowMs: DEFAULT_HYGIENE_THRESHOLDS.closedWithoutEvidenceWindowMs,
};
