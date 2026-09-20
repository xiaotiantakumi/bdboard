// bdboard-sso1.11: HygienePanel.tsx からハーネス hook 未登録行の表示専用 JSX を
// 移動しただけのファイル。挙動は一切変えていない。確認欄の開閉・実行状態は
// 引き続き親の state/mutation が持ち、ここは props 経由で受け取るだけ。
import { projectNameFallback } from '../../api';
import { buildHarnessHooksMessage, formatHarnessHooksDetail } from '../../harnessDisplay';
import { HARNESS_HOOKS_KIND_LABEL } from './constants';
import { harnessHooksRowKey } from './rowKeys';
import type { HarnessPackItem, RepairFeedback } from './types';

export function HarnessHooksRows({
  items,
  confirmingRepairKey,
  pendingRepairKey,
  repairError,
  repairDisabled,
  onBeginRepairConfirm,
  onConfirmHarnessUpdate,
  onCancelConfirm,
}: {
  readonly items: readonly HarnessPackItem[];
  readonly confirmingRepairKey: string | null;
  readonly pendingRepairKey: string | null;
  readonly repairError: RepairFeedback | null;
  readonly repairDisabled: boolean;
  readonly onBeginRepairConfirm: (rowKey: string) => void;
  readonly onConfirmHarnessUpdate: (item: HarnessPackItem, rowKey: string) => void;
  readonly onCancelConfirm: () => void;
}) {
  return (
    <>
      {items.map((item) => {
        const rowKey = harnessHooksRowKey(item);
        const isConfirming = confirmingRepairKey === rowKey;
        const isExecuting = repairDisabled && pendingRepairKey === rowKey;
        const rowError =
          repairError?.rowKey === rowKey ? repairError.message : null;

        return (
          <li key={rowKey}>
            <div className="hygiene-issue-row hygiene-issue-row-static">
              <span className="hygiene-kind-badge hygiene-kind-harness_hooks">
                {HARNESS_HOOKS_KIND_LABEL}
              </span>
              <span className="badge badge-stalled">警告</span>
              <span className="hygiene-issue-project" title={item.projectId}>
                {projectNameFallback(item.projectId)}
              </span>
              <span className="hygiene-issue-id">{item.pack.name}</span>
              <span
                className="hygiene-issue-message"
                title={formatHarnessHooksDetail(item.pack)}
              >
                {buildHarnessHooksMessage(item.pack)}
              </span>
            </div>
            <div className="hygiene-repair">
              {isConfirming ? (
                <div className="hygiene-repair-confirm">
                  <button
                    type="button"
                    className="hygiene-repair-confirm-btn"
                    disabled={repairDisabled}
                    onClick={() => onConfirmHarnessUpdate(item, rowKey)}
                  >
                    {isExecuting ? '実行中…' : '確定: hook を登録'}
                  </button>
                  <button
                    type="button"
                    className="hygiene-repair-cancel"
                    disabled={repairDisabled}
                    onClick={onCancelConfirm}
                  >
                    キャンセル
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="hygiene-repair-action"
                  disabled={repairDisabled}
                  onClick={() => onBeginRepairConfirm(rowKey)}
                >
                  hook を登録
                </button>
              )}
              {rowError !== null && (
                <p className="hygiene-repair-error" role="alert">
                  {rowError}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </>
  );
}
