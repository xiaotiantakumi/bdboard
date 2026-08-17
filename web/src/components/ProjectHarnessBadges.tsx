import { useQuery } from '@tanstack/react-query';
import { fetchProjectHarnessStatus } from '../api';
import {
  formatHarnessPackStatusLabel,
  harnessInjectButtonLabel,
  harnessPackNeedsAction,
} from '../harnessDisplay';
import { useHarnessFeedback, useHarnessInject } from '../hooks/useHarnessInject';

export interface ProjectHarnessBadgesProps {
  readonly projectId: string;
}

export function ProjectHarnessBadges({ projectId }: ProjectHarnessBadgesProps) {
  const { message, showFeedback } = useHarnessFeedback();
  const query = useQuery({
    queryKey: ['project-harness', projectId],
    queryFn: () => fetchProjectHarnessStatus(projectId),
  });
  const injectMutation = useHarnessInject({
    onSuccess: showFeedback,
    onError: showFeedback,
  });

  if (query.isLoading || query.isError || query.data === undefined) {
    return null;
  }

  if (query.data.packs.length === 0) {
    return null;
  }

  return (
    <span className="project-harness-badges" aria-label="ハーネス導入状況">
      {query.data.packs.map((pack) => {
        const needsAction = harnessPackNeedsAction(pack);
        const statusClassName = pack.drift
          ? 'project-harness-status project-harness-status-drift'
          : pack.installedVersion === null
            ? 'project-harness-status project-harness-status-missing'
            : 'project-harness-status project-harness-status-ok';

        return (
          <span key={pack.name} className="project-harness-pack">
            <span className="project-harness-pack-name">{pack.name}</span>
            <span className={statusClassName}>
              {formatHarnessPackStatusLabel(pack)}
            </span>
            {needsAction && (
              <button
                type="button"
                className="project-harness-action"
                disabled={injectMutation.isPending}
                onClick={() => {
                  injectMutation.mutate({ projectId, pack });
                }}
              >
                {injectMutation.isPending
                  ? '実行中…'
                  : harnessInjectButtonLabel(pack)}
              </button>
            )}
          </span>
        );
      })}
      {message !== '' && (
        <span className="project-harness-feedback" role="status" aria-live="polite">
          {message}
        </span>
      )}
    </span>
  );
}
