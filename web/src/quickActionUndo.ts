import type { QuickActionRequest, QuickActionUndoRequest } from './api';

/**
 * クイックアクション実行成功後にUndoスナックバーへ渡す情報。
 * message はスナックバーに表示する文言、undoRequest は「元に戻す」押下時に
 * quick-action/undo エンドポイントへ送る逆操作リクエスト。
 */
export interface QuickActionUndoPlan {
  readonly message: string;
  readonly undoRequest: QuickActionUndoRequest;
}

/**
 * 実行したクイックアクションから Undo プランを組み立てる。
 *
 * claim/close/defer は逆操作の形が一意に決まる(unclaim/reopen/undefer相当)ため
 * 追加情報は不要。priority は「実行前の値へ戻す」、undefer は「元の日付へ再 defer」
 * という操作なので、呼び出し元がアクション実行前に保持していた previousPriority /
 * previousDeferUntil を渡す必要がある。いずれかが無い場合は Undo を成立させられないため
 * null を返す(呼び出し元は Undo スナックバー自体を出さない = 握りつぶさず単に提示しない)。
 */
export function planQuickActionUndo(
  request: QuickActionRequest,
  previousPriority?: number,
  previousDeferUntil?: string,
): QuickActionUndoPlan | null {
  switch (request.action) {
    case 'claim':
      return { message: '着手しました', undoRequest: { action: 'claim' } };
    case 'close':
      return { message: '完了にしました', undoRequest: { action: 'close' } };
    case 'defer':
      return { message: '延期しました', undoRequest: { action: 'defer' } };
    case 'undefer':
      if (previousDeferUntil === undefined) {
        return null;
      }
      return {
        message: '保留を解除しました',
        undoRequest: { action: 'undefer', untilDate: previousDeferUntil },
      };
    case 'priority':
      if (previousPriority === undefined) {
        return null;
      }
      return {
        message: `優先度を P${request.priority} に変更しました`,
        undoRequest: {
          action: 'priority',
          previousPriority,
          // クイックアクションで実際にセットした値。Undo 実行時にサーバー側で現在値と
          // 突き合わせる CAS チェックの期待値になる(bdboard-3tw.82)。
          expectedCurrentPriority: request.priority,
        },
      };
  }
}
