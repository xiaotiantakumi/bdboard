import { useMutation, useQueryClient } from '@tanstack/react-query';
import { refreshExternalIssues } from '../../api/issue-reports-external';
import { useExternalIssues } from '../../hooks/useIssueReportPendingCount';
import { LoadingIndicator } from '../LoadingIndicator';
import { ExternalIssueCard } from './ExternalIssueCard';
import { externalStaleNote, externalStateMessage, refreshFailureMessage } from './externalIssueText';

export interface ExternalIssueListProps {
  /**
   * 開いているページがローカル直アクセスか (「新しく報告」と同じ判定。manualDraftAccess の isLoopbackHostname)。
   * 「今すぐ確認」と、gh の失敗の detail はローカルの読み手にだけ出す (サーバーの POST はローカル直アクセスだけ。detail はトンネル越しにも読めるが画面では出さない)。
   */
  readonly localAccess: boolean;
}

/**
 * 「届いた issue」の一覧 (bdboard-4y8q.9.5)。上に状態の文 (確認できたか・止まった理由)、続けてカード。
 * 状態は種類ごとの固定文で、gh の stderr を整えた `error.detail` はローカルのときだけ添える。
 */
export function ExternalIssueList({ localAccess }: ExternalIssueListProps) {
  const query = useExternalIssues();
  const client = useQueryClient();
  const refresh = useMutation({
    mutationFn: refreshExternalIssues,
    // 確認が失敗しても HTTP は 200 で、一覧の state: 'error' に出る。返った一覧をそのまま入れる。
    onSuccess: (list) => client.setQueryData(['issue-reports', 'external'], list),
  });

  if (query.isLoading) return <LoadingIndicator />;
  const list = query.data;
  if (query.isError || list === undefined) {
    return (
      <p className="error-message" role="alert">
        届いた issue を読み込めませんでした。
      </p>
    );
  }

  const staleNote = externalStaleNote(list);
  const showDetail = localAccess && list.state === 'error' && list.error !== null && list.error.detail !== '';

  return (
    <div className="external-issue-list-wrap">
      <div className="external-issue-status">
        <p role="status" className="external-issue-state-message">
          {externalStateMessage(list)}
        </p>
        {staleNote !== null && <p className="issue-draft-muted">{staleNote}</p>}
        {showDetail && <p className="issue-draft-muted">詳細: {list.error?.detail}</p>}
        {list.truncated && <p className="issue-draft-muted">続きがあります。一覧は上限までです。</p>}
        {list.skippedLines > 0 && (
          <p className="issue-draft-muted">GitHub の応答のうち読めなかった行が {list.skippedLines} 行あります。</p>
        )}
        {localAccess && (
          <button type="button" className="btn" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            今すぐ確認
          </button>
        )}
        {refresh.isPending && <p role="status">確認しています…</p>}
        {refresh.isError && (
          <p className="error-message" role="alert">
            {refreshFailureMessage(refresh.error)}
          </p>
        )}
      </div>
      <ul className="external-issue-list">
        {list.issues.map((issue) => (
          <ExternalIssueCard key={issue.number} issue={issue} />
        ))}
      </ul>
    </div>
  );
}
