// bdboard-sso1.11: HygienePanel.tsx からハーネス一括更新の確認/結果表示 JSX を
// 移動しただけのファイル。挙動は一切変えていない。確認欄の開閉・実行状態は
// 引き続き親 (HygienePanel) の state/mutation が持ち、ここは props 経由で受け取る
// だけの表示専用コンポーネント。
import type { RefObject } from 'react';
import { projectNameFallback } from '../../api';
import {
  buildHarnessBulkSummaryMessage,
  describeHarnessBulkFailure,
  type HarnessBulkUpdateSummary,
  type HarnessBulkUpdateTarget,
} from '../../harnessBulkUpdate';

export function HarnessBulkUpdateSection({
  bulkUpdatableItems,
  bulkUpdateTargets,
  bulkUpdateSummary,
  repairDisabled,
  isBulkUpdating,
  bulkConfirmButtonRef,
  onBeginBulkUpdateConfirm,
  onConfirmBulkUpdate,
  onCancelBulkUpdateTargets,
  onCloseBulkUpdateSummary,
}: {
  readonly bulkUpdatableItems: readonly unknown[];
  readonly bulkUpdateTargets: readonly HarnessBulkUpdateTarget[] | null;
  readonly bulkUpdateSummary: HarnessBulkUpdateSummary | null;
  readonly repairDisabled: boolean;
  readonly isBulkUpdating: boolean;
  readonly bulkConfirmButtonRef: RefObject<HTMLButtonElement | null>;
  readonly onBeginBulkUpdateConfirm: () => void;
  readonly onConfirmBulkUpdate: () => void;
  readonly onCancelBulkUpdateTargets: () => void;
  readonly onCloseBulkUpdateSummary: () => void;
}) {
  if (
    !(
      bulkUpdatableItems.length > 0 ||
      bulkUpdateTargets !== null ||
      bulkUpdateSummary !== null
    )
  ) {
    return null;
  }
  return (
    <li key="harness-bulk-update">
      <div className="hygiene-repair">
        {bulkUpdateTargets !== null ? (
          <div
            className="hygiene-repair-confirm"
            role="group"
            aria-label="ハーネス一括更新の確認"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !repairDisabled) {
                event.stopPropagation();
                onCancelBulkUpdateTargets();
              }
            }}
          >
            <p>次の要更新パックを1件ずつ更新します。</p>
            <ul>
              {bulkUpdateTargets.map((target) => (
                <li
                  key={`${target.projectId}-${target.packName}`}
                  title={target.projectId}
                >
                  {projectNameFallback(target.projectId)} / {target.packName}: v
                  {target.installedVersion} → v{target.availableVersion}
                </li>
              ))}
            </ul>
            <button
              ref={bulkConfirmButtonRef}
              type="button"
              className="hygiene-repair-confirm-btn"
              disabled={repairDisabled}
              onClick={onConfirmBulkUpdate}
            >
              {isBulkUpdating ? '更新中…' : '確定: まとめて更新'}
            </button>
            <button
              type="button"
              className="hygiene-repair-cancel"
              disabled={repairDisabled}
              onClick={onCancelBulkUpdateTargets}
            >
              キャンセル
            </button>
          </div>
        ) : bulkUpdatableItems.length > 0 ? (
          // 結果の表示中でも要更新が残っていれば (一部失敗など) そのまま再試行できる。
          <button
            type="button"
            className="hygiene-repair-action"
            disabled={repairDisabled}
            onClick={onBeginBulkUpdateConfirm}
          >
            要更新 {bulkUpdatableItems.length} 件をまとめて更新
          </button>
        ) : null}
        {bulkUpdateSummary !== null && bulkUpdateTargets === null && (
          <div role="group" aria-label="ハーネス一括更新の結果">
            <p>{buildHarnessBulkSummaryMessage(bulkUpdateSummary)}</p>
            <ul>
              {bulkUpdateSummary.results.map((result) => (
                <li
                  key={`${result.target.projectId}-${result.target.packName}`}
                  title={result.target.projectId}
                >
                  {projectNameFallback(result.target.projectId)} / {result.target.packName}:{' '}
                  {result.status === 'success'
                    ? '成功'
                    : `失敗 (${describeHarnessBulkFailure(result.error)})`}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="hygiene-repair-cancel"
              onClick={onCloseBulkUpdateSummary}
            >
              結果を閉じる
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
