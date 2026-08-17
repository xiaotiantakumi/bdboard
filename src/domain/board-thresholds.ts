import {
  DEFAULT_LIVENESS_THRESHOLDS,
  type LivenessThresholds,
} from './liveness.js';
import {
  DEFAULT_STALLED_THRESHOLDS,
  type StalledThresholds,
} from './stalled.js';

export interface BoardThresholdsOverrides {
  readonly stalledAfterMs?: number;
  readonly livenessActiveMs?: number;
  readonly livenessIdleMs?: number;
  readonly livenessStaleMs?: number;
}

export interface ResolvedBoardThresholds {
  readonly stalledThresholds: StalledThresholds;
  readonly livenessThresholds: LivenessThresholds;
}

/** 1秒未満は実用上意味がないため下限とする。 */
export const BOARD_THRESHOLDS_MIN_MS = 1_000;

/** stalled / liveness stale は「何日も更新なし」の上限。UI破綻を防ぐ穏当な30日上限。 */
export const BOARD_THRESHOLDS_MAX_STALLED_OR_STALE_MS = 30 * 24 * 60 * 60_000;

/** active / idle はセッション活動の細かい帯域。7日上限で十分。 */
export const BOARD_THRESHOLDS_MAX_ACTIVE_OR_IDLE_MS = 7 * 24 * 60 * 60_000;

const FIELD_LIMITS: Record<keyof BoardThresholdsOverrides, { min: number; max: number; label: string }> = {
  stalledAfterMs: {
    min: BOARD_THRESHOLDS_MIN_MS,
    max: BOARD_THRESHOLDS_MAX_STALLED_OR_STALE_MS,
    label: '滞留判定',
  },
  livenessActiveMs: {
    min: BOARD_THRESHOLDS_MIN_MS,
    max: BOARD_THRESHOLDS_MAX_ACTIVE_OR_IDLE_MS,
    label: 'liveness active',
  },
  livenessIdleMs: {
    min: BOARD_THRESHOLDS_MIN_MS,
    max: BOARD_THRESHOLDS_MAX_ACTIVE_OR_IDLE_MS,
    label: 'liveness idle',
  },
  livenessStaleMs: {
    min: BOARD_THRESHOLDS_MIN_MS,
    max: BOARD_THRESHOLDS_MAX_STALLED_OR_STALE_MS,
    label: 'liveness stale',
  },
};

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function resolveBoardThresholds(
  overrides?: BoardThresholdsOverrides,
): ResolvedBoardThresholds {
  return {
    stalledThresholds: {
      stalledAfterMs:
        overrides?.stalledAfterMs ?? DEFAULT_STALLED_THRESHOLDS.stalledAfterMs,
    },
    livenessThresholds: {
      activeMs:
        overrides?.livenessActiveMs ?? DEFAULT_LIVENESS_THRESHOLDS.activeMs,
      idleMs: overrides?.livenessIdleMs ?? DEFAULT_LIVENESS_THRESHOLDS.idleMs,
      staleMs:
        overrides?.livenessStaleMs ?? DEFAULT_LIVENESS_THRESHOLDS.staleMs,
    },
  };
}

export function validateBoardThresholds(
  overrides: BoardThresholdsOverrides,
): { ok: boolean; errors: readonly string[] } {
  const errors: string[] = [];

  for (const [key, limits] of Object.entries(FIELD_LIMITS) as [
    keyof BoardThresholdsOverrides,
    (typeof FIELD_LIMITS)[keyof BoardThresholdsOverrides],
  ][]) {
    const value = overrides[key];
    if (value === undefined) {
      continue;
    }
    if (!isPositiveInteger(value)) {
      errors.push(`${limits.label}は正の整数で指定してください`);
      continue;
    }
    if (value < limits.min) {
      errors.push(`${limits.label}は${limits.min}ミリ秒以上にしてください`);
      continue;
    }
    if (value > limits.max) {
      errors.push(`${limits.label}は${limits.max}ミリ秒以下にしてください`);
    }
  }

  const resolved = resolveBoardThresholds(overrides);
  const { activeMs, idleMs, staleMs } = resolved.livenessThresholds;

  if (activeMs >= idleMs) {
    errors.push('liveness active は liveness idle より短くしてください');
  }
  if (idleMs >= staleMs) {
    errors.push('liveness idle は liveness stale より短くしてください');
  }

  return { ok: errors.length === 0, errors };
}

export const DEFAULT_BOARD_THRESHOLDS_OVERRIDES: BoardThresholdsOverrides = {
  stalledAfterMs: DEFAULT_STALLED_THRESHOLDS.stalledAfterMs,
  livenessActiveMs: DEFAULT_LIVENESS_THRESHOLDS.activeMs,
  livenessIdleMs: DEFAULT_LIVENESS_THRESHOLDS.idleMs,
  livenessStaleMs: DEFAULT_LIVENESS_THRESHOLDS.staleMs,
};
