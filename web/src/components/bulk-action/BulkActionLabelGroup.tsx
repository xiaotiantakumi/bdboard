// bdboard-sso1.23 PR-B: BulkActionBar.tsx からラベル入力・候補一覧・付与ボタンの表示部品を
// move-only で切り出しただけのファイル。state は親(BulkActionBar)に残し、
// props 経由で渡す。DOM(JSX)は移動前と同一。
import { isImeComposingKeyEvent } from '../../imeGuard';

export interface BulkActionLabelGroupProps {
  bulkLabelInput: string;
  onBulkLabelInputChange: (value: string) => void;
  actionsDisabled: boolean;
  canSubmitBulkLabel: boolean;
  bulkLabelSuggestions: readonly string[];
  trimmedBulkLabelInput: string;
  onBulkLabelAction: () => void;
  onSelectSuggestion: (label: string) => void;
}

export function BulkActionLabelGroup({
  bulkLabelInput,
  onBulkLabelInputChange,
  actionsDisabled,
  canSubmitBulkLabel,
  bulkLabelSuggestions,
  trimmedBulkLabelInput,
  onBulkLabelAction,
  onSelectSuggestion,
}: BulkActionLabelGroupProps) {
  return (
    <div className="bulk-action-label-group">
      <input
        type="text"
        className="bulk-action-label-input"
        aria-label="付与するラベル"
        value={bulkLabelInput}
        onChange={(event) => onBulkLabelInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (isImeComposingKeyEvent(event)) {
              return;
            }
            event.preventDefault();
            if (canSubmitBulkLabel && !actionsDisabled) {
              onBulkLabelAction();
            }
          }
        }}
        disabled={actionsDisabled}
        maxLength={200}
        placeholder="ラベル"
      />
      {trimmedBulkLabelInput.length > 0 && bulkLabelSuggestions.length > 0 && (
        <ul className="dependency-suggestions bulk-label-suggestions">
          {bulkLabelSuggestions.map((label) => (
            <li key={label}>
              <button
                type="button"
                className="dependency-suggestion-btn"
                disabled={actionsDisabled}
                onClick={() => onSelectSuggestion(label)}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn btn-small bulk-action-btn"
        disabled={actionsDisabled || !canSubmitBulkLabel}
        onClick={onBulkLabelAction}
      >
        ラベル付与
      </button>
    </div>
  );
}
