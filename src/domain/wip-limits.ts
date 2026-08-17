export interface WipLimitsOverrides {
  readonly inProgressWipLimit?: number;
  readonly inProgressWipLimitByProject?: Readonly<Record<string, number>>;
}

export interface WipStatus {
  readonly limit: number | undefined;
  readonly count: number;
  readonly exceeded: boolean;
}

/** 実用上の下限。1枚未満の上限は意味がない。 */
export const WIP_LIMIT_MIN = 1;

/** UI・運用上の穏当な上限。 */
export const WIP_LIMIT_MAX = 999;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * 対象ビュー(全体 or 特定プロジェクト)に対する In Progress レーンの実効 WIP 上限を返す。
 * プロジェクト別指定があれば優先し、なければグローバル、どちらも無ければ undefined (上限なし)。
 */
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

export function validateWipLimits(
  overrides: WipLimitsOverrides,
): { ok: boolean; errors: readonly string[] } {
  const errors: string[] = [];

  const globalLimit = overrides.inProgressWipLimit;
  if (globalLimit !== undefined) {
    if (!isPositiveInteger(globalLimit)) {
      errors.push('In Progress WIP上限(全体)は正の整数で指定してください');
    } else if (globalLimit < WIP_LIMIT_MIN) {
      errors.push(`In Progress WIP上限(全体)は${WIP_LIMIT_MIN}以上にしてください`);
    } else if (globalLimit > WIP_LIMIT_MAX) {
      errors.push(`In Progress WIP上限(全体)は${WIP_LIMIT_MAX}以下にしてください`);
    }
  }

  const byProject = overrides.inProgressWipLimitByProject;
  if (byProject !== undefined) {
    for (const [projectId, limit] of Object.entries(byProject)) {
      if (projectId.trim() === '') {
        errors.push('プロジェクト別 WIP上限のプロジェクト ID は空にできません');
        continue;
      }
      if (!isPositiveInteger(limit)) {
        errors.push(
          `プロジェクト「${projectId}」の WIP上限は正の整数で指定してください`,
        );
        continue;
      }
      if (limit < WIP_LIMIT_MIN) {
        errors.push(
          `プロジェクト「${projectId}」の WIP上限は${WIP_LIMIT_MIN}以上にしてください`,
        );
        continue;
      }
      if (limit > WIP_LIMIT_MAX) {
        errors.push(
          `プロジェクト「${projectId}」の WIP上限は${WIP_LIMIT_MAX}以下にしてください`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export const DEFAULT_WIP_LIMITS_OVERRIDES: WipLimitsOverrides = {};
