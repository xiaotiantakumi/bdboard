/** 一括更新の対象。UI の表示値を確認時点で固定するため、パック状態そのものは持たない。 */
export interface HarnessBulkUpdateTarget {
  readonly projectId: string;
  readonly packName: string;
  readonly installedVersion: string | null;
  readonly availableVersion: string;
}

export type HarnessBulkUpdateResult =
  | { readonly target: HarnessBulkUpdateTarget; readonly status: 'success' }
  | { readonly target: HarnessBulkUpdateTarget; readonly status: 'failure'; readonly error: unknown };

export interface HarnessBulkUpdateSummary {
  readonly results: readonly HarnessBulkUpdateResult[];
  readonly successCount: number;
  readonly failureCount: number;
}

/** 注入 API を一件ずつ呼び、失敗しても後続の更新を続ける。 */
export async function runHarnessBulkUpdate(
  targets: readonly HarnessBulkUpdateTarget[],
  inject: (target: HarnessBulkUpdateTarget) => Promise<unknown>,
): Promise<HarnessBulkUpdateSummary> {
  const results: HarnessBulkUpdateResult[] = [];
  for (const target of targets) {
    try {
      await inject(target);
      results.push({ target, status: 'success' });
    } catch (error) {
      results.push({ target, status: 'failure', error });
    }
  }
  return {
    results,
    successCount: results.filter((result) => result.status === 'success').length,
    failureCount: results.filter((result) => result.status === 'failure').length,
  };
}
