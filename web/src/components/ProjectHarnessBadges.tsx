import { useQuery } from '@tanstack/react-query';
import { fetchProjectHarnessStatus } from '../api';
import {
  formatHarnessContractDetail,
  formatHarnessContractLabel,
  formatHarnessHooksDetail,
  formatHarnessHooksLabel,
  formatHarnessPackStatusLabel,
  harnessContractNeedsAttention,
  harnessHooksNeedAttention,
  harnessInjectButtonLabel,
  harnessPackNeedsAction,
} from '../harnessDisplay';
import { useHarnessFeedback, useHarnessInject } from '../hooks/useHarnessInject';

export interface ProjectHarnessBadgesProps {
  readonly projectId: string;
}

/**
 * bdboard-gyvv: ⋯ メニューに出す導入バージョンの1行 (`bdboard-harness v1.2`)。
 * 未導入・読み込み中・取得失敗のときは何も出さない (要対応の警告は見出し側が持つ)。
 */
export function ProjectHarnessVersion({
  projectId,
  projectName,
}: ProjectHarnessBadgesProps & { readonly projectName?: string }) {
  const query = useQuery({
    queryKey: ['project-harness', projectId],
    queryFn: () => fetchProjectHarnessStatus(projectId),
  });
  const pack = query.data?.packs.find((entry) => entry.installedVersion !== null);
  if (pack === undefined) {
    return null;
  }
  return (
    <p className="overflow-menu-footnote">
      {projectName !== undefined && `${projectName}: `}
      {pack.name} v{pack.installedVersion}
    </p>
  );
}

/**
 * 見出し (プロジェクト名の隣) には警告だけを出す: 要対応のパック (未導入 / 要更新 /
 * hook 不足 + 注入ボタン) と、要注意の検証コントラクト。正常なバージョン表示は ⋯ メニュー
 * (ProjectHarnessVersion) に移した (bdboard-gyvv)。
 */
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

  const contract = query.data.contract;
  const contractLabel = formatHarnessContractLabel(contract);

  const actionPacks = query.data.packs.filter(harnessPackNeedsAction);
  const showContract = contractLabel !== null && harnessContractNeedsAttention(contract);

  if (actionPacks.length === 0 && !showContract && message === '') {
    return null;
  }

  return (
    <span className="project-harness-badges" aria-label="ハーネス導入状況">
      {actionPacks.map((pack) => {
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
            {harnessHooksNeedAttention(pack) && (
              <span
                className="project-harness-status project-harness-status-hooks"
                title={formatHarnessHooksDetail(pack)}
              >
                {formatHarnessHooksLabel(pack)}
              </span>
            )}
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
      {showContract && (
        <span
          className={
            harnessContractNeedsAttention(contract)
              ? 'project-harness-contract project-harness-contract-warn'
              : 'project-harness-contract'
          }
          title={formatHarnessContractDetail(contract) ?? undefined}
        >
          {contractLabel}
        </span>
      )}
      {message !== '' && (
        <span className="project-harness-feedback" role="status" aria-live="polite">
          {message}
        </span>
      )}
    </span>
  );
}
