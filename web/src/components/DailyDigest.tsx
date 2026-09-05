import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import {
  fetchActivity,
  fetchBoard,
  fetchPendingDecisions,
  fetchProjects,
} from '../api';
import { copyTextToClipboard } from '../bdCommands';
import { useAutoClearedValue } from '../hooks/useAutoClearedValue';
import {
  ACTIVITY_WINDOW_DAYS,
  activityWindowLabel,
  type ActivityWindowDays,
} from '../uiPersistedState';
import { buildDailyDigestMarkdown } from './dailyDigestMarkdown';
import { LoadingIndicator } from './LoadingIndicator';
import { togglePressedProps } from './toggleGroupA11y';

const COPY_FEEDBACK_MS = 2000;
const DIGEST_ACTIVITY_LIMIT = 500;

export interface DailyDigestProps {
  readonly projectIds: readonly string[];
  windowDays: ActivityWindowDays;
  onWindowDaysChange: (days: ActivityWindowDays) => void;
  /** テスト用の固定時刻。省略時は new Date()。 */
  now?: Date;
}

function firstQueryErrorMessage(errors: readonly unknown[]): string {
  for (const error of errors) {
    if (error !== null && error !== undefined) {
      return error instanceof Error
        ? error.message
        : 'ダイジェストの読み込みに失敗しました';
    }
  }
  return 'ダイジェストの読み込みに失敗しました';
}

export function DailyDigest({
  projectIds,
  windowDays,
  onWindowDaysChange,
  now: nowOverride,
}: DailyDigestProps) {
  const projectIdsKey = projectIds.join(',');

  const activityQuery = useQuery({
    queryKey: ['digest-activity', windowDays, projectIdsKey],
    queryFn: () => fetchActivity(windowDays, DIGEST_ACTIVITY_LIMIT, projectIds),
  });

  // App.tsx の boardQuery と digest ビュー時のキー形 ['board', 'merged', projectIdsKey]
  // を揃えているので react-query キャッシュが共有され二重フェッチにならない。
  const boardQuery = useQuery({
    queryKey: ['board', 'merged', projectIdsKey],
    queryFn: () => fetchBoard({ projectIds: [...projectIds], view: 'merged' }),
  });

  const pendingDecisionsQuery = useQuery({
    queryKey: ['pending-decisions'],
    queryFn: fetchPendingDecisions,
  });

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });

  const now = nowOverride ?? new Date();

  const projectNames = useMemo(() => {
    if (projectsQuery.data === undefined) {
      return undefined;
    }
    return new Map(projectsQuery.data.map((project) => [project.id, project.name]));
  }, [projectsQuery.data]);

  const markdown = useMemo(() => {
    if (
      activityQuery.data === undefined ||
      boardQuery.data === undefined ||
      pendingDecisionsQuery.data === undefined ||
      projectNames === undefined
    ) {
      return null;
    }

    return buildDailyDigestMarkdown({
      now,
      windowDays,
      activityEvents: activityQuery.data,
      board: boardQuery.data.merged ?? null,
      pendingDecisions: pendingDecisionsQuery.data,
      projectNames,
      selectedProjectIds: projectIds,
    });
  }, [
    activityQuery.data,
    boardQuery.data,
    pendingDecisionsQuery.data,
    projectNames,
    now,
    windowDays,
    projectIds,
  ]);

  // bdboard-ty72: コピー結果の表示は await の継続から出るので、素の setTimeout だと
  // アンマウント後にタイマーを仕掛けうる。useAutoClearedValue がマウント中でしか
  // 表示せず、アンマウント時にタイマーも片付ける。
  const { value: ariaLiveMessage, show: showCopyMessage } = useAutoClearedValue(
    '',
    COPY_FEEDBACK_MS,
  );

  const handleCopy = useCallback(async () => {
    if (markdown === null) {
      return;
    }

    try {
      await copyTextToClipboard(markdown);
      showCopyMessage('Markdown をコピーしました');
    } catch (copyError) {
      console.error('Failed to copy daily digest markdown', copyError);
      showCopyMessage('コピーできませんでした');
    }
  }, [markdown, showCopyMessage]);

  const isLoading =
    activityQuery.isLoading ||
    boardQuery.isLoading ||
    pendingDecisionsQuery.isLoading ||
    projectsQuery.isLoading;

  const isError =
    activityQuery.isError ||
    boardQuery.isError ||
    pendingDecisionsQuery.isError ||
    projectsQuery.isError;

  const errorMessage = isError
    ? firstQueryErrorMessage([
        activityQuery.error,
        boardQuery.error,
        pendingDecisionsQuery.error,
        projectsQuery.error,
      ])
    : null;

  return (
    <section className="daily-digest" aria-label="デイリーダイジェスト">
      <div className="daily-digest-header">
        <h2 className="daily-digest-title">デイリーダイジェスト</h2>
        <div className="activity-window-group">
          <span className="header-label">期間</span>
          <div className="toggle-group">
            {ACTIVITY_WINDOW_DAYS.map((option) => (
              <button
                key={option}
                type="button"
                className={`toggle-btn${windowDays === option ? ' active' : ''}`}
                {...togglePressedProps(windowDays === option)}
                onClick={() => onWindowDaysChange(option)}
              >
                {activityWindowLabel(option)}
              </button>
            ))}
          </div>
        </div>
        <div className="daily-digest-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void handleCopy()}
            disabled={markdown === null}
          >
            Markdown をコピー
          </button>
          <span className="daily-digest-feedback" role="status" aria-live="polite">
            {ariaLiveMessage}
          </span>
        </div>
      </div>

      {isLoading && <LoadingIndicator />}
      {errorMessage !== null && <p className="error-message">{errorMessage}</p>}
      {!isLoading && errorMessage === null && markdown !== null && (
        <pre className="daily-digest-preview">{markdown}</pre>
      )}
    </section>
  );
}
