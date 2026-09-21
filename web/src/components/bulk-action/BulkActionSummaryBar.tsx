// bdboard-sso1.23 PR-B: BulkActionBar.tsx から選択件数・全解除ボタンの表示部品を
// move-only で切り出しただけのファイル。state は親(BulkActionBar)に残し、
// props 経由で渡す。DOM(JSX)は移動前と同一。
export interface BulkActionSummaryBarProps {
  selectedCount: number;
  mutationPending: boolean;
  onClear: () => void;
}

export function BulkActionSummaryBar({
  selectedCount,
  mutationPending,
  onClear,
}: BulkActionSummaryBarProps) {
  return (
    <div className="bulk-action-bar-summary">
      <span className="bulk-action-bar-count">{selectedCount}件選択中</span>
      <button
        type="button"
        className="btn btn-small bulk-action-bar-clear"
        onClick={onClear}
        disabled={mutationPending}
      >
        全解除
      </button>
    </div>
  );
}
