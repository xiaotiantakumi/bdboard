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

export interface BulkIdOutcome {
  succeeded: string[];
  failed: { id: string; error: unknown }[];
}

export async function runBulkById(
  ids: string[],
  execute: (id: string) => Promise<void>,
): Promise<BulkIdOutcome> {
  const succeeded: string[] = [];
  const failed: { id: string; error: unknown }[] = [];
  for (const id of ids) {
    try {
      await execute(id);
      succeeded.push(id);
    } catch (error) {
      failed.push({ id, error });
    }
  }
  return { succeeded, failed };
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
