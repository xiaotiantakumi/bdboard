// bdboard-sso1.11: HygienePanel.tsx から自己完結した表示専用コンポーネントを
// 移動しただけのファイル。挙動は一切変えていない。
import type { ReclaimProjectStatusDto } from '../../api';
import { formatReclaimProjectLine } from './staleLease';

export function ReclaimProjectLines({
  projects,
}: {
  readonly projects: readonly ReclaimProjectStatusDto[];
}) {
  return projects.map((projectStatus) => {
    // 見送り理由 (skipped: …) や回収要約。これが無いと「回収件数不明」
    // の原因が /api/lease-health の JSON を直接見ないと分からない。
    const summary = projectStatus.rawSummary?.trim() ?? '';
    return (
      <p key={projectStatus.projectId}>
        <span>{projectStatus.projectId}: </span>
        <span>{formatReclaimProjectLine(projectStatus)}</span>
        {summary.length > 0 && (
          <span className="hygiene-reclaim-status-summary">
            {' / '}
            {summary}
          </span>
        )}
        {projectStatus.lastError !== null && (
          <span className="hygiene-reclaim-status-error">
            {' '}
            / エラー: {projectStatus.lastError}
          </span>
        )}
      </p>
    );
  });
}
