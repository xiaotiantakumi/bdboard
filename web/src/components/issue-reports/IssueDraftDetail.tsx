import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchIssueDraft, type IssueDraftEditResponseDto } from '../../api/issue-reports';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { LoadingIndicator } from '../LoadingIndicator';
import { IssueDraftDismiss } from './IssueDraftDismiss';
import { IssueDraftLocalSection } from './IssueDraftLocalSection';
import { IssueDraftPublicSection } from './IssueDraftPublicSection';
import { IssueDraftVersionSection } from './IssueDraftVersionSection';
import { ERROR_TEXT_TRIMMED_NOTE } from './issueDraftErrors';
import { draftKindLabel, draftStatusLabel } from './issueDraftText';

export interface IssueDraftDetailProps {
  readonly draftId: string;
  /** 狭い幅で一覧へ戻るボタン。 */
  readonly onBack: () => void;
}

// 「投稿される内容は変わりません」は、公開本文を保存時に固定している今のサーバーが前提。公開本文を手元のエラー本文から
// 作り直す処理が入ったら、この文言を見直す (レビュー NIT-10)。
function savedNotice(response: IssueDraftEditResponseDto): string {
  return response.errorTextTrimmed ? `保存しました。${ERROR_TEXT_TRIMMED_NOTE}` : '保存しました。';
}

/** 右側の中身: 1) 投稿される内容 2) 投稿されない手元の情報 3) 版の比較、と見送り。 */
export function IssueDraftDetail({ draftId, onBack }: IssueDraftDetailProps) {
  const query = useQuery({
    // root はリテラルで書く (boardChangedQueryKeys.test.ts が静的に読む)。形は hooks/useIssueReportPendingCount.ts の説明のとおり。
    queryKey: ['issue-reports', 'detail', draftId],
    queryFn: () => fetchIssueDraft(draftId),
  });
  const [notice, setNotice] = useState<{ readonly id: string; readonly text: string } | null>(null);

  if (query.isLoading) return <LoadingIndicator />;
  if (query.isError || query.data === undefined) {
    const message = query.error instanceof Error ? query.error.message : '';
    return (
      <p className="error-message" role="alert">
        下書きを読み込めませんでした。{message}
      </p>
    );
  }

  const { draft } = query.data;
  const images = query.data.images ?? [];
  return (
    <article className="issue-draft-detail" aria-label="下書きの中身">
      <button type="button" className="btn btn-small issue-reports-back" onClick={onBack}>
        一覧へ戻る
      </button>
      <header className="issue-draft-detail-header">
        <p className="issue-draft-detail-meta">
          <span className={`issue-draft-status issue-draft-status-${draft.status}`}>{draftStatusLabel(draft.status)}</span>
          <span>{draftKindLabel(draft.kind)}</span>
          <span>{draft.occurrenceCount} 回</span>
          <span>最後: {formatAbsoluteTime(draft.lastOccurredAt)}</span>
        </p>
        {draft.status === 'dismissed' && draft.dismissReason !== undefined && (
          <p className="issue-draft-muted">見送りの理由: {draft.dismissReason}</p>
        )}
        {draft.issueUrl !== undefined && draft.issueUrl.startsWith('https://github.com/') && (
          <p className="issue-draft-muted">
            投稿先:{' '}
            <a href={draft.issueUrl} target="_blank" rel="noreferrer noopener">
              {draft.issueNumber !== undefined ? `#${draft.issueNumber}` : draft.issueUrl}
            </a>
          </p>
        )}
      </header>
      {notice !== null && notice.id === draft.id && (
        <p className="issue-draft-notice" role="status">
          {notice.text}
        </p>
      )}
      <IssueDraftPublicSection
        draft={draft}
        onSaved={(response) => setNotice({ id: response.draft.id, text: savedNotice(response) })}
      />
      <IssueDraftLocalSection draft={draft} images={images} />
      <IssueDraftVersionSection draft={draft} latestHarnessVersion={query.data.latestHarnessVersion} />
      {draft.status === 'pending' && (
        <IssueDraftDismiss draftId={draft.id} onDismissed={() => setNotice({ id: draft.id, text: '見送りにしました。' })} />
      )}
    </article>
  );
}
