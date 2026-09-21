// bdboard-sso1.23 PR-B: BulkActionBar.tsx から延期期間セレクト・カスタム日付・延期ボタンの表示部品を
// move-only で切り出しただけのファイル。state は親(BulkActionBar)に残し、
// props 経由で渡す。DOM(JSX)は移動前と同一。
import {
  DEFER_PERIOD_OPTIONS,
  todayLocalDateInputValue,
  type DeferPeriodKind,
} from '../../deferPeriods';

export interface BulkActionDeferGroupProps {
  deferPeriodKind: DeferPeriodKind;
  onDeferPeriodKindChange: (kind: DeferPeriodKind) => void;
  customDeferDate: string;
  onCustomDeferDateChange: (value: string) => void;
  actionsDisabled: boolean;
  deferSubmitDisabled: boolean;
  onDeferBulkAction: () => void;
}

export function BulkActionDeferGroup({
  deferPeriodKind,
  onDeferPeriodKindChange,
  customDeferDate,
  onCustomDeferDateChange,
  actionsDisabled,
  deferSubmitDisabled,
  onDeferBulkAction,
}: BulkActionDeferGroupProps) {
  return (
    <div
      className={`quick-action-defer-group${deferPeriodKind === 'custom' ? ' quick-action-defer-group-custom' : ''}`}
    >
      <select
        aria-label="延期期間"
        value={deferPeriodKind}
        onChange={(event) =>
          onDeferPeriodKindChange(event.target.value as DeferPeriodKind)
        }
        disabled={actionsDisabled}
      >
        {DEFER_PERIOD_OPTIONS.map(({ kind, label }) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </select>
      {deferPeriodKind === 'custom' && (
        <input
          type="date"
          min={todayLocalDateInputValue()}
          value={customDeferDate}
          onChange={(event) => onCustomDeferDateChange(event.target.value)}
          disabled={actionsDisabled}
        />
      )}
      <button
        type="button"
        className="btn btn-small bulk-action-btn"
        disabled={actionsDisabled || deferSubmitDisabled}
        onClick={onDeferBulkAction}
      >
        延期
      </button>
    </div>
  );
}
