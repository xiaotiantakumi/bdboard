// bdboard-sso1.65: useBulkActions.ts (親フック) から、確認パネルが持つ state
// (confirmingAction/deferPeriodKind/customDeferDate/closeReason/bulkLabelInput/
// lastOutcome) と、確認パネル用の2つの ref (confirmPanelRef/cancelConfirmRef)
// を useReducer ベースのカスタムフックへ切り出した。親フックが個別に公開している
// 各セッター (setDeferPeriodKind 等) はここでは action を dispatch する薄い
// ラッパーとして再現しており、呼び出し側 (useBulkQuickAction/useBulkLabelAction
// の各パラメータ) のシグネチャは変えていない。
import { useCallback, useReducer, useRef, type RefObject } from 'react';
import type { BulkIdOutcome, BulkQuickActionOutcome } from '../../../bulkQuickAction';
import { DEFAULT_DEFER_PERIOD, type DeferPeriodKind } from '../../../deferPeriods';
import type { BulkConfirmingAction } from '../types';

interface ConfirmPanelFields {
  readonly confirmingAction: BulkConfirmingAction | null;
  readonly deferPeriodKind: DeferPeriodKind;
  readonly customDeferDate: string;
  readonly closeReason: string;
  readonly bulkLabelInput: string;
  readonly lastOutcome: BulkQuickActionOutcome | BulkIdOutcome | null;
}

type ConfirmPanelAction =
  | { type: 'set-confirming-action'; value: BulkConfirmingAction | null }
  | { type: 'set-defer-period-kind'; value: DeferPeriodKind }
  | { type: 'set-custom-defer-date'; value: string }
  | { type: 'set-close-reason'; value: string }
  | { type: 'set-bulk-label-input'; value: string }
  | { type: 'set-last-outcome'; value: BulkQuickActionOutcome | BulkIdOutcome | null }
  | { type: 'reset-confirm-fields' };

const initialConfirmPanelFields: ConfirmPanelFields = {
  confirmingAction: null,
  deferPeriodKind: DEFAULT_DEFER_PERIOD,
  customDeferDate: '',
  closeReason: '',
  bulkLabelInput: '',
  lastOutcome: null,
};

function confirmPanelReducer(
  state: ConfirmPanelFields,
  action: ConfirmPanelAction,
): ConfirmPanelFields {
  switch (action.type) {
    case 'set-confirming-action':
      return { ...state, confirmingAction: action.value };
    case 'set-defer-period-kind':
      return { ...state, deferPeriodKind: action.value };
    case 'set-custom-defer-date':
      return { ...state, customDeferDate: action.value };
    case 'set-close-reason':
      return { ...state, closeReason: action.value };
    case 'set-bulk-label-input':
      return { ...state, bulkLabelInput: action.value };
    case 'set-last-outcome':
      return { ...state, lastOutcome: action.value };
    case 'reset-confirm-fields':
      return {
        ...state,
        confirmingAction: null,
        deferPeriodKind: DEFAULT_DEFER_PERIOD,
        customDeferDate: '',
        closeReason: '',
      };
    default:
      return state;
  }
}

export interface ConfirmPanelState extends ConfirmPanelFields {
  readonly confirmPanelRef: RefObject<HTMLDivElement | null>;
  readonly cancelConfirmRef: RefObject<HTMLButtonElement | null>;
  readonly setConfirmingAction: (action: BulkConfirmingAction | null) => void;
  readonly setDeferPeriodKind: (kind: DeferPeriodKind) => void;
  readonly setCustomDeferDate: (value: string) => void;
  readonly setCloseReason: (value: string) => void;
  readonly setBulkLabelInput: (value: string) => void;
  readonly setLastOutcome: (
    outcome: BulkQuickActionOutcome | BulkIdOutcome | null,
  ) => void;
  /** confirmingAction/deferPeriodKind/customDeferDate/closeReason を一括で
   * 初期値へ戻す。現在の呼び出し元は useConfirmPanelDismissal.handleCancelConfirm
   * (キャンセルボタン/Escape) のみ。一括クイックアクション成功時
   * (useBulkQuickAction.ts の onSuccess) は、このフックの
   * setConfirmingAction/setDeferPeriodKind/setCustomDeferDate/setCloseReason を
   * 分割前と同じく個別に呼んでおり (#623 で切り出したファイルは無変更)、
   * ここには依存していない。bulkLabelInput/lastOutcome はこの reset では戻さない
   * (一括ラベル付与の成功時は setBulkLabelInput だけを個別にクリアする)。 */
  readonly resetConfirmFields: () => void;
}

export function useConfirmPanelState(): ConfirmPanelState {
  const [state, dispatch] = useReducer(
    confirmPanelReducer,
    initialConfirmPanelFields,
  );
  const confirmPanelRef = useRef<HTMLDivElement>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement>(null);

  const setConfirmingAction = useCallback(
    (value: BulkConfirmingAction | null) =>
      dispatch({ type: 'set-confirming-action', value }),
    [],
  );
  const setDeferPeriodKind = useCallback(
    (value: DeferPeriodKind) => dispatch({ type: 'set-defer-period-kind', value }),
    [],
  );
  const setCustomDeferDate = useCallback(
    (value: string) => dispatch({ type: 'set-custom-defer-date', value }),
    [],
  );
  const setCloseReason = useCallback(
    (value: string) => dispatch({ type: 'set-close-reason', value }),
    [],
  );
  const setBulkLabelInput = useCallback(
    (value: string) => dispatch({ type: 'set-bulk-label-input', value }),
    [],
  );
  const setLastOutcome = useCallback(
    (value: BulkQuickActionOutcome | BulkIdOutcome | null) =>
      dispatch({ type: 'set-last-outcome', value }),
    [],
  );
  const resetConfirmFields = useCallback(
    () => dispatch({ type: 'reset-confirm-fields' }),
    [],
  );

  return {
    ...state,
    confirmPanelRef,
    cancelConfirmRef,
    setConfirmingAction,
    setDeferPeriodKind,
    setCustomDeferDate,
    setCloseReason,
    setBulkLabelInput,
    setLastOutcome,
    resetConfirmFields,
  };
}
