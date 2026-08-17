import type { QuickActionRequest } from './api';

export interface BulkQuickActionTarget {
  id: string;
  request: QuickActionRequest;
  /** priority の Undo 用に、実行前の値をカード読み込み時点で保持しておく */
  previousPriority?: number;
}

export interface BulkQuickActionOutcome {
  succeeded: BulkQuickActionTarget[];
  failed: { id: string; error: unknown }[];
}

export async function runBulkQuickAction(
  targets: BulkQuickActionTarget[],
  execute: (id: string, request: QuickActionRequest) => Promise<void>,
): Promise<BulkQuickActionOutcome> {
  const succeeded: BulkQuickActionTarget[] = [];
  const failed: { id: string; error: unknown }[] = [];
  for (const target of targets) {
    try {
      await execute(target.id, target.request);
      succeeded.push(target);
    } catch (error) {
      failed.push({ id: target.id, error });
    }
  }
  return { succeeded, failed };
}
