// bdboard-sso1.11: HygienePanel.tsx から検証コントラクト不足行の表示専用 JSX を
// 移動しただけのファイル。挙動は一切変えていない。確認欄の開閉・実行状態は
// 引き続き親の state/mutation が持ち、ここは props 経由で受け取るだけ。
import { projectNameFallback } from '../../api';
import {
  formatHarnessContractDetail,
  formatHarnessContractLabel,
  harnessContractNeedsTicket,
} from '../../harnessDisplay';
import { HARNESS_CONTRACT_KIND_LABEL } from './constants';
import { harnessContractRowKey } from './rowKeys';
import type { HarnessContractItem, RepairFeedback } from './types';

export function HarnessContractRows({
  items,
  confirmingRepairKey,
  pendingRepairKey,
  repairError,
  repairDisabled,
  onBeginRepairConfirm,
  onConfirmContractTicket,
  onCancelConfirm,
}: {
  readonly items: readonly HarnessContractItem[];
  readonly confirmingRepairKey: string | null;
  readonly pendingRepairKey: string | null;
  readonly repairError: RepairFeedback | null;
  readonly repairDisabled: boolean;
  readonly onBeginRepairConfirm: (rowKey: string) => void;
  readonly onConfirmContractTicket: (item: HarnessContractItem, rowKey: string) => void;
  readonly onCancelConfirm: () => void;
}) {
  return (
    <>
      {items.map((item) => {
        const rowKey = harnessContractRowKey(item);
        const label = formatHarnessContractLabel(item.contract);
        const detail = formatHarnessContractDetail(item.contract);
        const needsTicket = harnessContractNeedsTicket(item.contract);
        const isConfirming = confirmingRepairKey === rowKey;
        const isExecuting = repairDisabled && pendingRepairKey === rowKey;
        const rowError =
          repairError?.rowKey === rowKey ? repairError.message : null;

        return (
          <li key={rowKey}>
            <div className="hygiene-issue-row hygiene-issue-row-static">
              <span className="hygiene-kind-badge hygiene-kind-harness_contract">
                {HARNESS_CONTRACT_KIND_LABEL}
              </span>
              <span className="badge badge-stalled">警告</span>
              <span className="hygiene-issue-project" title={item.projectId}>
                {projectNameFallback(item.projectId)}
              </span>
              <span className="hygiene-issue-id">{label}</span>
              <span
                className="hygiene-issue-message"
                title={detail ?? undefined}
              >
                {detail}
              </span>
            </div>
            {needsTicket && (
              <div className="hygiene-repair">
                {isConfirming ? (
                  <div className="hygiene-repair-confirm">
                    <button
                      type="button"
                      className="hygiene-repair-confirm-btn"
                      disabled={repairDisabled}
                      onClick={() => onConfirmContractTicket(item, rowKey)}
                    >
                      {isExecuting ? '実行中…' : '確定: チケットを起票'}
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
                    チケットを起票
                  </button>
                )}
                {rowError !== null && (
                  <p className="hygiene-repair-error" role="alert">
                    {rowError}
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </>
  );
}
