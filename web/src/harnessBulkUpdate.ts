import { ApiError } from './api';
import { describeWriteError } from './writeAccessMessage';

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

/**
 * 一括更新の失敗理由。サーバーは注入失敗を 500 `{ error: 'injection failed', detail }` で
 * 返すため、describeWriteError だけでは「injection failed」しか残らない。一括更新は
 * 失敗理由の表示が要件なので、detail があれば併記する。
 */
export function describeHarnessBulkFailure(error: unknown): string {
  const base = describeWriteError(error, 'ハーネスの更新に失敗しました');
  if (
    error instanceof ApiError &&
    error.detail !== undefined &&
    error.detail.length > 0 &&
    error.detail !== base
  ) {
    return `${base}: ${error.detail}`;
  }
  return base;
}

export function buildHarnessBulkSummaryMessage(summary: HarnessBulkUpdateSummary): string {
  return `まとめて更新: 成功 ${summary.successCount} 件・失敗 ${summary.failureCount} 件`;
}
