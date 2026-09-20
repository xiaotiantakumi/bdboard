// bdboard-sso1.5 (PR-E): TicketDetailPanel.tsx の「Labels」表示・編集ブロック
// を移動しただけのコンポーネント。state・mutation は useTicketLabels (親で
// 呼び出し) に残し、値とハンドラを props で受け取る表示専用コンポーネント。
// JSX・className・aria属性・文言・DOM構造は移動前から変えていない。
import { isImeComposingKeyEvent } from '../../imeGuard';
import { describeWriteError } from '../../writeAccessMessage';

export interface TicketLabelsSectionProps {
  currentLabels: readonly string[];
  labelInputQuery: string;
  onLabelInputQueryChange: (value: string) => void;
  trimmedLabelInput: string;
  labelSuggestions: string[];
  canSubmitLabel: boolean;
  labelMutationPending: boolean;
  isAddPending: boolean;
  error: unknown;
  onAddLabel: (label: string) => void;
  onRemoveLabel: (label: string) => void;
}

export function TicketLabelsSection({
  currentLabels,
  labelInputQuery,
  onLabelInputQueryChange,
  trimmedLabelInput,
  labelSuggestions,
  canSubmitLabel,
  labelMutationPending,
  isAddPending,
  error,
  onAddLabel,
  onRemoveLabel,
}: TicketLabelsSectionProps) {
  return (
    <div className="detail-field">
      <div className="detail-field-label">Labels</div>
      {currentLabels.length > 0 && (
        <div className="detail-label-badges">
          {currentLabels.map((label) => (
            <span key={label} className="badge badge-label">
              {label}
              <button
                type="button"
                className="btn btn-small label-remove-btn"
                aria-label={`ラベル ${label} を削除`}
                disabled={labelMutationPending}
                onClick={() => onRemoveLabel(label)}
              >
                削除
              </button>
            </span>
          ))}
        </div>
      )}
      <label className="label-add-label" htmlFor="label-add-input">
        ラベルを追加
      </label>
      <input
        id="label-add-input"
        type="text"
        className="label-add-input"
        value={labelInputQuery}
        onChange={(event) => onLabelInputQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            if (isImeComposingKeyEvent(event)) {
              return;
            }
            event.preventDefault();
            if (canSubmitLabel && !labelMutationPending) {
              onAddLabel(trimmedLabelInput);
            }
          }
        }}
        disabled={labelMutationPending}
        maxLength={200}
      />
      {trimmedLabelInput.length > 0 && labelSuggestions.length > 0 && (
        <ul className="dependency-suggestions label-suggestions">
          {labelSuggestions.map((label) => (
            <li key={label}>
              <button
                type="button"
                className="dependency-suggestion-btn"
                disabled={labelMutationPending}
                onClick={() => onAddLabel(label)}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="label-add-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={!canSubmitLabel || labelMutationPending}
          onClick={() => onAddLabel(trimmedLabelInput)}
        >
          {isAddPending ? '追加中…' : '追加'}
        </button>
      </div>
      {error !== null && (
        <p className="error-message">
          {describeWriteError(error, 'ラベルの更新に失敗しました')}
        </p>
      )}
    </div>
  );
}
