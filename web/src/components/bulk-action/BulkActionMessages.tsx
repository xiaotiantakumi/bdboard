// bdboard-sso1.23 PR-B: BulkActionBar.tsx から失敗件数・エラーメッセージの表示部品を
// move-only で切り出しただけのファイル。state は親(BulkActionBar)に残し、
// props 経由で渡す。DOM(JSX)は移動前と同一。
import type { BulkIdOutcome, BulkQuickActionOutcome } from '../../bulkQuickAction';
import { describeWriteError } from '../../writeAccessMessage';
import { formatBulkFailure } from './messages';

export interface BulkActionMessagesProps {
  lastOutcome: BulkQuickActionOutcome | BulkIdOutcome | null;
  mutationError: unknown;
}

export function BulkActionMessages({
  lastOutcome,
  mutationError,
}: BulkActionMessagesProps) {
  return (
    <>
      {lastOutcome !== null && lastOutcome.failed.length > 0 && (
        <p className="bulk-action-failure" role="alert">
          {formatBulkFailure(lastOutcome)}
        </p>
      )}
      {mutationError !== null && (
        <p className="error-message bulk-action-error">
          {describeWriteError(mutationError, '一括操作に失敗しました')}
        </p>
      )}
    </>
  );
}
