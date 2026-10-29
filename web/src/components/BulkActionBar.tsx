import { useRef, useState } from 'react';
import type { BulkIdOutcome } from '../bulkQuickAction';
import { useBulkBarHeightVar } from '../hooks/useBulkBarHeightVar';
import { describeWriteError } from '../writeAccessMessage';
import { useBulkSelection } from './BulkSelectionProvider';
import { BulkActionSummaryBar } from './bulk-action/BulkActionSummaryBar';
import type { BulkActionBarProps } from './bulk-action/types';
import { useBulkRespond } from './bulk-action/useBulkRespond';

export type { BulkActionBarProps } from './bulk-action/types';

const QUICK_ANSWERS = ['OK', 'レビューしました'];

export function BulkActionBar({ cardsById, pendingDecisionIds }: BulkActionBarProps) {
  const bulkSelection = useBulkSelection();
  const barRef = useRef<HTMLDivElement>(null);
  const [comment, setComment] = useState('');
  const [lastOutcome, setLastOutcome] = useState<BulkIdOutcome | null>(null);
  const selectedCount = bulkSelection?.selectedIds.size ?? 0;

  const mutation = useBulkRespond(
    cardsById,
    pendingDecisionIds,
    bulkSelection,
    setLastOutcome,
  );

  const visible = selectedCount > 0 || lastOutcome !== null;
  useBulkBarHeightVar(barRef, visible);

  if (bulkSelection === null || !visible) {
    return null;
  }

  const trimmed = comment.trim();
  const send = (text: string, clearInput: boolean) => {
    setLastOutcome(null);
    mutation.mutate(text, {
      onSuccess: (outcome) => {
        if (clearInput && outcome.failed.length === 0) {
          setComment('');
        }
      },
    });
  };

  return (
    <div ref={barRef} className="bulk-action-bar">
      <BulkActionSummaryBar
        selectedCount={selectedCount}
        mutationPending={mutation.isPending}
        onClear={() => {
          bulkSelection.clear();
          setLastOutcome(null);
        }}
      />
      {selectedCount > 0 && (
      <>
      <div className="bulk-action-bar-buttons">
        {QUICK_ANSWERS.map((text) => (
          <button
            key={text}
            type="button"
            className="btn btn-small bulk-action-btn"
            disabled={mutation.isPending}
            onClick={() => send(text, false)}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="bulk-action-comment">
        <textarea
          className="bulk-action-comment-input"
          aria-label="一括コメント"
          placeholder="選択中の全チケットへのコメント"
          rows={2}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-small bulk-action-btn"
          disabled={mutation.isPending || trimmed.length === 0}
          onClick={() => send(trimmed, true)}
        >
          {mutation.isPending ? '送信中…' : 'コメント送信'}
        </button>
      </div>
      </>
      )}
      {lastOutcome !== null && (
        <p
          className={
            lastOutcome.failed.length > 0 ? 'bulk-action-failure' : 'bulk-action-result'
          }
          role={lastOutcome.failed.length > 0 ? 'alert' : 'status'}
        >
          {`${lastOutcome.succeeded.length}件成功`}
          {lastOutcome.failed.length > 0 &&
            ` / ${lastOutcome.failed.length}件失敗: ${lastOutcome.failed
              .map((entry) => entry.id)
              .join(', ')}`}
        </p>
      )}
      {mutation.error !== null && (
        <p className="error-message bulk-action-error">
          {describeWriteError(mutation.error, '一括送信に失敗しました')}
        </p>
      )}
    </div>
  );
}
