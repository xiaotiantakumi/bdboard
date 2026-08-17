/**
 * Browser-side mirror of src/domain/wip-limits.ts.
 * web/ must not import from src/ (dependency-cruiser: web-no-server-src).
 */

export interface WipLimitsOverrides {
  readonly inProgressWipLimit?: number;
  readonly inProgressWipLimitByProject?: Readonly<Record<string, number>>;
}

export interface WipStatus {
  readonly limit: number | undefined;
  readonly count: number;
  readonly exceeded: boolean;
}

export function resolveWipLimitForLane(
  overrides: WipLimitsOverrides | undefined,
  projectId: string | undefined,
): number | undefined {
  if (projectId !== undefined) {
    const projectLimit = overrides?.inProgressWipLimitByProject?.[projectId];
    if (projectLimit !== undefined) {
      return projectLimit;
    }
  }
  return overrides?.inProgressWipLimit;
}

export function computeWipStatus(cardCount: number, limit: number | undefined): WipStatus {
  return {
    limit,
    count: cardCount,
    exceeded: limit !== undefined && cardCount > limit,
  };
}
