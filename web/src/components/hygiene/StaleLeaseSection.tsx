// bdboard-sso1.11: HygienePanel.tsx から stale lease / reclaim 状況の表示専用
// JSX を移動しただけのファイル。挙動は一切変えていない。
import type { ReclaimProjectStatusDto, StaleLeaseDto } from '../../api';
import { projectNameFallback } from '../../api';
import { RECLAIM_STATUS_KIND_LABEL, STALE_LEASE_KIND_LABEL } from './constants';
import { ReclaimProjectLines } from './ReclaimProjectLines';
import { buildStaleLeaseMessage } from './staleLease';

export function StaleLeaseSection({
  staleLeases,
  reclaimEnabled,
  reclaimProjects,
  reclaimProblemProjects,
  onSelectTicket,
}: {
  readonly staleLeases: readonly StaleLeaseDto[];
  readonly reclaimEnabled: boolean;
  readonly reclaimProjects: readonly ReclaimProjectStatusDto[];
  readonly reclaimProblemProjects: readonly ReclaimProjectStatusDto[];
  readonly onSelectTicket: (ticketId: string) => void;
}) {
  return (
    <>
      {staleLeases.length > 0 && (
        <li key="stale-leases">
          <div className="hygiene-stale-lease-group">
            {staleLeases.map((staleLease) => (
              <button
                key={staleLease.ticketId}
                type="button"
                className="hygiene-issue-row"
                onClick={() => onSelectTicket(staleLease.ticketId)}
              >
                <span className="hygiene-kind-badge hygiene-kind-stale_lease">
                  {STALE_LEASE_KIND_LABEL}
                </span>
                <span className="badge badge-stalled">警告</span>
                <span className="hygiene-issue-project" title={staleLease.projectId}>
                  {projectNameFallback(staleLease.projectId)}
                </span>
                <span className="hygiene-issue-id">{staleLease.ticketId}</span>
                <span className="hygiene-issue-message">
                  {buildStaleLeaseMessage(staleLease)}
                </span>
              </button>
            ))}
            <div
              className="hygiene-reclaim-status"
              role="group"
              aria-label="自動 reclaim 状況"
            >
              {!reclaimEnabled ? (
                <p>自動 reclaim は無効です</p>
              ) : (
                <ReclaimProjectLines projects={reclaimProjects} />
              )}
            </div>
          </div>
        </li>
      )}
      {staleLeases.length === 0 && reclaimProblemProjects.length > 0 && (
        <li key="reclaim-status">
          {/* レイアウト (縦並び + 6px 間隔) は stale lease グループと共用する。 */}
          <div className="hygiene-stale-lease-group">
            <div className="hygiene-issue-row hygiene-issue-row-static">
              <span className="hygiene-kind-badge hygiene-kind-stale_lease">
                {RECLAIM_STATUS_KIND_LABEL}
              </span>
              <span className="badge badge-stalled">警告</span>
              <span className="hygiene-issue-message">
                巡回の見送り・エラーがあります
              </span>
            </div>
            <div
              className="hygiene-reclaim-status"
              role="group"
              aria-label="自動 reclaim 状況"
            >
              <ReclaimProjectLines projects={reclaimProblemProjects} />
            </div>
          </div>
        </li>
      )}
    </>
  );
}
