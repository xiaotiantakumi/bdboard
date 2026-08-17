import type { AgentSession } from './session.js';

export const LIVENESS_LEVELS = ['active', 'idle', 'stale', 'dormant'] as const;

export type Liveness = (typeof LIVENESS_LEVELS)[number];

export interface LivenessThresholds {
  readonly activeMs: number;
  readonly idleMs: number;
  readonly staleMs: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessThresholds = {
  activeMs: 2 * 60_000,
  idleMs: 30 * 60_000,
  staleMs: 24 * 60 * 60_000,
};

export function computeLiveness(
  now: Date,
  session: Pick<AgentSession, 'lastActivityAt' | 'alive'>,
  thresholds: LivenessThresholds = DEFAULT_LIVENESS_THRESHOLDS,
): Liveness {
  if (!session.alive) {
    return 'dormant';
  }

  const age = Math.max(0, now.getTime() - session.lastActivityAt.getTime());

  if (age <= thresholds.activeMs) {
    return 'active';
  }
  if (age <= thresholds.idleMs) {
    return 'idle';
  }
  if (age <= thresholds.staleMs) {
    return 'stale';
  }
  return 'dormant';
}

const LIVENESS_RANKS: Record<Liveness, number> = {
  active: 0,
  idle: 1,
  stale: 2,
  dormant: 3,
};

export function livenessRank(liveness: Liveness): number {
  return LIVENESS_RANKS[liveness];
}
