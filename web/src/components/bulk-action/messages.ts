// bdboard-sso1.23 PR-A: BulkActionBar.tsx から純粋なメッセージ整形関数を移動しただけの
// ファイル。挙動は一切変えていない。
import type { BulkIdOutcome, BulkQuickActionOutcome } from '../../bulkQuickAction';
import type { BulkConfirmingAction } from './types';

export function formatBulkConfirmTitle(action: BulkConfirmingAction): string {
  switch (action.kind) {
    case 'close':
      return '一括完了の確認';
    case 'defer':
      return '一括延期の確認';
    case 'priority-up':
      return '一括で優先度を上げる確認';
    case 'priority-down':
      return '一括で優先度を下げる確認';
    case 'add-label':
      return '一括ラベル付与の確認';
  }
}

export function formatBulkConfirmDescription(
  action: BulkConfirmingAction,
  targetCount: number,
): string {
  switch (action.kind) {
    case 'close':
      return `選択中の ${targetCount} 件を完了にします。よろしいですか?`;
    case 'defer':
      return `選択中の ${targetCount} 件を ${action.untilDate} まで延期します。よろしいですか?`;
    case 'priority-up':
      return `選択中のうち優先度を上げられる ${targetCount} 件の優先度を上げます。よろしいですか?`;
    case 'priority-down':
      return `選択中のうち優先度を下げられる ${targetCount} 件の優先度を下げます。よろしいですか?`;
    case 'add-label':
      return `選択中の ${targetCount} 件にラベル「${action.label}」を付与します。よろしいですか?`;
  }
}

export function bulkSuccessMessage(
  action: BulkConfirmingAction,
  count: number,
): string {
  switch (action.kind) {
    case 'close':
      return `${count}件を完了にしました`;
    case 'defer':
      return `${count}件を延期しました`;
    case 'priority-up':
      return `${count}件の優先度を上げました`;
    case 'priority-down':
      return `${count}件の優先度を下げました`;
    case 'add-label':
      return `${count}件にラベルを付与しました`;
  }
}

export function formatBulkFailure(
  outcome: BulkQuickActionOutcome | BulkIdOutcome,
): string {
  const ids = outcome.failed.map((entry) => entry.id).join(', ');
  return `${outcome.failed.length}件失敗: ${ids}`;
}
