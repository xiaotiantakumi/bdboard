// bdboard-sso1.11: HygienePanel.tsx からマージスロット保持状況の表示専用 JSX を
// 移動しただけのファイル。挙動は一切変えていない。
import { projectNameFallback, type MergeSlotStatusDto } from '../../api';
import { MERGE_SLOT_KIND_LABEL } from './constants';
import { formatStaleDuration } from './staleLease';

export function MergeSlotSection({
  heldMergeSlots,
}: {
  readonly heldMergeSlots: readonly MergeSlotStatusDto[];
}) {
  if (heldMergeSlots.length === 0) {
    return null;
  }
  return (
    <li key="merge-slot">
      <div className="hygiene-merge-slot-group">
        {heldMergeSlots.map((status) => (
          <div
            key={status.projectId}
            className="hygiene-issue-row hygiene-issue-row-static"
          >
            <span className="hygiene-kind-badge hygiene-kind-merge_slot">
              {MERGE_SLOT_KIND_LABEL}
            </span>
            {status.isLongHeld && (
              <span className="badge badge-stalled">警告</span>
            )}
            <span className="hygiene-issue-project" title={status.projectId}>
              {projectNameFallback(status.projectId)}
            </span>
            <span className="hygiene-issue-id">
              {status.holder ?? '(不明)'}
            </span>
            <span className="hygiene-issue-message">
              保持中 {formatStaleDuration(status.heldForMs)}
            </span>
          </div>
        ))}
      </div>
    </li>
  );
}
