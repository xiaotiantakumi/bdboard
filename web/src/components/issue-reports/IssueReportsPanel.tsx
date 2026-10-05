import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchIssueDrafts, type IssueDraftStatus } from '../../api/issue-reports';
import { ISSUE_REPORTS_REFETCH_MS } from '../../hooks/useIssueReportPendingCount';
import { LoadingIndicator } from '../LoadingIndicator';
import { togglePressedProps } from '../toggleGroupA11y';
import { IssueDraftDetail } from './IssueDraftDetail';
import { IssueDraftList } from './IssueDraftList';
import { DRAFT_STATUS_ORDER, draftStatusLabel } from './issueDraftText';

const EMPTY_TEXT: Readonly<Record<IssueDraftStatus, string>> = {
  pending: '未処理の下書きはありません。',
  posted: '投稿済みの下書きはありません。',
  dismissed: '見送った下書きはありません。',
};

/**
 * 「不具合報告」タブ (bdboard-4y8q.3.2、docs/ISSUE-REPORTING.md)。左に下書きの一覧 (未処理 / 投稿済み / 見送り)、
 * 右に選んだ下書きの中身。狭い幅では一覧と中身を切り替えて 1 列で出す (styles/issue-reports.css)。
 * 投稿ボタンは bdboard-4y8q.4 で足す。
 */
export function IssueReportsPanel() {
  const [status, setStatus] = useState<IssueDraftStatus>('pending');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 件数のバッジと同じ間隔で読み直す (下書きは bd の外にあり SSE では届かない。バッジと一覧の数を食い違わせない)。
  const listQuery = useQuery({
    queryKey: ['issue-reports', 'list'],
    queryFn: fetchIssueDrafts,
    refetchInterval: ISSUE_REPORTS_REFETCH_MS,
  });

  const allDrafts = listQuery.data?.drafts ?? [];
  const drafts = allDrafts.filter((draft) => draft.status === status);
  const countOf = (target: IssueDraftStatus) => allDrafts.filter((draft) => draft.status === target).length;

  return (
    <section
      className={`issue-reports-panel${selectedId !== null ? ' has-selection' : ''}`}
      aria-label="不具合報告"
    >
      <div className="issue-reports-list-pane">
        <div className="issue-reports-header">
          <h2 className="issue-reports-title">不具合報告</h2>
          <div className="toggle-group issue-reports-status-toggle">
            {DRAFT_STATUS_ORDER.map((option) => (
              <button
                key={option}
                type="button"
                className={`toggle-btn${status === option ? ' active' : ''}`}
                {...togglePressedProps(status === option)}
                onClick={() => {
                  // 切り替えた先の一覧に無い下書きの中身を右に出し続けない。
                  if (option !== status) setSelectedId(null);
                  setStatus(option);
                }}
              >
                {draftStatusLabel(option)} ({countOf(option)})
              </button>
            ))}
          </div>
        </div>
        {listQuery.isLoading && <LoadingIndicator />}
        {listQuery.isError && (
          <p className="error-message" role="alert">
            不具合報告の一覧を読み込めませんでした。{listQuery.error instanceof Error ? listQuery.error.message : ''}
          </p>
        )}
        {!listQuery.isLoading && !listQuery.isError && (
          <IssueDraftList drafts={drafts} selectedId={selectedId} onSelect={setSelectedId} emptyText={EMPTY_TEXT[status]} />
        )}
      </div>
      <div className="issue-reports-detail-pane">
        {selectedId === null ? (
          <p className="issue-draft-muted">左の一覧から下書きを選ぶと、投稿される内容と手元の情報がここに出ます。</p>
        ) : (
          <IssueDraftDetail key={selectedId} draftId={selectedId} onBack={() => setSelectedId(null)} />
        )}
      </div>
    </section>
  );
}
