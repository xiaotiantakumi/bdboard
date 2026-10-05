import type { IssueDraftSummaryDto } from '../../api/issue-reports';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { draftKindLabel } from './issueDraftText';

export interface IssueDraftListProps {
  readonly drafts: readonly IssueDraftSummaryDto[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly emptyText: string;
}

/**
 * 左の一覧。各行: 種類・題名・発生したプロジェクト・回数・最後に起きた時刻。
 * 一覧の API (GET drafts) はプロジェクトの名前を載せず数だけなので、行には数を出す (名前は中身で見る)。
 */
export function IssueDraftList({ drafts, selectedId, onSelect, emptyText }: IssueDraftListProps) {
  if (drafts.length === 0) {
    return <p className="issue-draft-muted issue-draft-list-empty">{emptyText}</p>;
  }
  return (
    <ul className="issue-draft-list">
      {drafts.map((draft) => {
        const selected = draft.id === selectedId;
        return (
          <li key={draft.id}>
            <button
              type="button"
              className={`issue-draft-row${selected ? ' selected' : ''}`}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(draft.id)}
            >
              <span className={`issue-draft-kind issue-draft-kind-${draft.kind}`}>{draftKindLabel(draft.kind)}</span>
              <span className="issue-draft-row-title">{draft.title}</span>
              <span className="issue-draft-row-meta">
                <span>{draft.occurredProjectCount} プロジェクト</span>
                <span>{draft.occurrenceCount} 回</span>
                <span>最後: {formatAbsoluteTime(draft.lastOccurredAt)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
