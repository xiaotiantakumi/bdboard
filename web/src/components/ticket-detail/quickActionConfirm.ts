// bdboard-sso1.5: TicketDetailPanel.tsx から quick-action 確認ダイアログの
// 純粋ヘルパーを移動しただけのファイル。挙動は一切変えていない。
import type { QuickActionRequest } from '../../api';
import type { ConfirmingQuickAction } from './types';

export function formatQuickActionConfirmTitle(action: ConfirmingQuickAction): string {
  switch (action.kind) {
    case 'claim':
      return '着手の確認';
    case 'close':
      return '完了の確認';
    case 'defer':
      return '延期の確認';
    case 'priority':
      return '優先度変更の確認';
  }
}

export function formatQuickActionConfirmDescription(
  action: ConfirmingQuickAction,
): string {
  switch (action.kind) {
    case 'claim':
      return 'このチケットを着手(claim)します。よろしいですか?';
    case 'close':
      return 'このチケットをクローズします。よろしいですか?';
    case 'defer':
      return `${action.untilDate} まで延期します。よろしいですか?`;
    case 'priority':
      return `優先度を P${action.priority} に変更します。よろしいですか?`;
  }
}

export function toQuickActionRequest(action: ConfirmingQuickAction, closeReason: string): QuickActionRequest {
  switch (action.kind) {
    case 'claim':
      return { action: 'claim' };
    case 'close': {
      const trimmedReason = closeReason.trim();
      return {
        action: 'close',
        ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
      };
    }
    case 'defer':
      return { action: 'defer', untilDate: action.untilDate };
    case 'priority':
      return { action: 'priority', priority: action.priority };
  }
}
