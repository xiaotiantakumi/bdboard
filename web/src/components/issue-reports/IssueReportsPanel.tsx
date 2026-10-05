import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { fetchIssueDrafts, type IssueDraftStatus } from '../../api/issue-reports';
import { ISSUE_REPORTS_REFETCH_MS } from '../../hooks/useIssueReportPendingCount';
import { useExternalIssues } from '../../hooks/useIssueReportPendingCount';
import { LoadingIndicator } from '../LoadingIndicator';
import { togglePressedProps } from '../toggleGroupA11y';
import { IssueDraftDetail } from './IssueDraftDetail';
import { IssueDraftList } from './IssueDraftList';
import { IssueDraftManualForm } from './IssueDraftManualForm';
import { ExternalIssueList } from './ExternalIssueList';
import { DRAFT_STATUS_ORDER, draftStatusLabel } from './issueDraftText';
import { MANUAL_LOCAL_ONLY_NOTICE, isLoopbackHostname, type ReportProject } from './manualDraftAccess';

const EMPTY_TEXT: Readonly<Record<IssueDraftStatus, string>> = {
  pending: '未処理の下書きはありません。',
  posted: '投稿済みの下書きはありません。',
  dismissed: '見送った下書きはありません。',
};

/**
 * 「不具合報告」タブ (bdboard-4y8q.3.2、docs/ISSUE-REPORTING.md)。左に下書きの一覧 (未処理 / 投稿済み / 見送り)、
 * 右に選んだ下書きの中身。狭い幅では一覧と中身を切り替えて 1 列で出す (styles/issue-reports.css)。
 * 投稿ボタンは bdboard-4y8q.4 で足す。
 *
 * 見出しの「新しく報告」(bdboard-4y8q.6.8) は、右ペインに手で書く画面 (IssueDraftManualForm) を出す。サーバーの受け口はローカル直アクセスだけなので、
 * hostname が localhost / 127.0.0.1 / [::1] 以外のときはボタンを押せなくして理由を出す (画面の先回りで、正はサーバーの 403)。
 * 作れたら、未処理の一覧に切り替えて、その下書きを選ぶ。
 */
export interface IssueReportsPanelProps {
  /** ボードでちょうど 1 つ選んでいるプロジェクト (reportProjectOf)。書く画面が、題名の漏れ検出の鍵として一緒に送る。 */
  readonly reportProject?: ReportProject | undefined;
  /** 開いているページのホスト名。既定は window.location.hostname (テストで差し替えられるようにしている)。 */
  readonly hostname?: string;
}

export function IssueReportsPanel({ reportProject, hostname = window.location.hostname }: IssueReportsPanelProps = {}) {
  const [status, setStatus] = useState<IssueDraftStatus>('pending');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 右ペインに「新しく報告」の書く画面を出している間は true (詳細の代わりに出す)。
  const [composing, setComposing] = useState(false);
  const [showExternal, setShowExternal] = useState(false);
  const externalQuery = useExternalIssues();
  const localAccess = isLoopbackHostname(hostname);
  const noticeId = useId();
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
      className={`issue-reports-panel${selectedId !== null || composing ? ' has-selection' : ''}${showExternal ? ' is-external' : ''}`}
      aria-label="不具合報告"
    >
      <div className="issue-reports-list-pane">
        <div className="issue-reports-header">
          <div className="issue-reports-title-row">
            <h2 className="issue-reports-title">不具合報告</h2>
            <button
              type="button"
              className="btn"
              disabled={!localAccess}
              aria-describedby={localAccess ? undefined : noticeId}
              onClick={() => {
                setSelectedId(null);
                setComposing(true);
                setShowExternal(false);
              }}
            >
              新しく報告
            </button>
          </div>
          {!localAccess && (
            <p className="issue-draft-muted" id={noticeId}>
              {MANUAL_LOCAL_ONLY_NOTICE}
            </p>
          )}
          <div className="toggle-group issue-reports-status-toggle">
            {DRAFT_STATUS_ORDER.map((option) => (
              <button
                key={option}
                type="button"
                className={`toggle-btn${!showExternal && status === option ? ' active' : ''}`}
                {...togglePressedProps(!showExternal && status === option)}
                onClick={() => {
                  // 切り替えた先の一覧に無い下書きの中身を右に出し続けない。
                  if (option !== status) setSelectedId(null);
                  setStatus(option);
                  setShowExternal(false);
                  setComposing(false);
                }}
              >
                {draftStatusLabel(option)} ({countOf(option)})
              </button>
            ))}
            </div>
            {externalQuery.data?.enabled === true && <button type="button" className={`toggle-btn${showExternal ? ' active' : ''}`} {...togglePressedProps(showExternal)} onClick={() => { setSelectedId(null); setComposing(false); setShowExternal(true); }}>届いた issue ({externalQuery.data.issues.length})</button>}
          </div>
        {showExternal ? <ExternalIssueList localAccess={localAccess} /> : listQuery.isLoading && <LoadingIndicator />}
        {!showExternal && listQuery.isError && (
          <p className="error-message" role="alert">
            不具合報告の一覧を読み込めませんでした。{listQuery.error instanceof Error ? listQuery.error.message : ''}
          </p>
        )}
        {!showExternal && !listQuery.isLoading && !listQuery.isError && (
          <IssueDraftList
            drafts={drafts}
            selectedId={selectedId}
            onSelect={(id) => {
              // 右ペインに出せるのは 1 つだけ。書く画面は閉じて、選んだ下書きを出す。
              setComposing(false);
              setSelectedId(id);
            }}
            emptyText={EMPTY_TEXT[status]}
          />
        )}
      </div>
      <div className="issue-reports-detail-pane">
        {composing ? (
          <IssueDraftManualForm
            project={reportProject}
            onCancel={() => setComposing(false)}
            onCreated={(draft) => {
              // 作った下書きは必ず未処理。見送りなどの一覧を見ていても、未処理に切り替えて選ぶ。
              setStatus('pending');
              setSelectedId(draft.id);
              setComposing(false);
            }}
          />
        ) : selectedId === null ? (
          <p className="issue-draft-muted">左の一覧から下書きを選ぶと、投稿される内容と手元の情報がここに出ます。</p>
        ) : (
          <IssueDraftDetail key={selectedId} draftId={selectedId} onBack={() => setSelectedId(null)} />
        )}
      </div>
    </section>
  );
}
