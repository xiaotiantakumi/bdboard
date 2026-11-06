// bdboard-l1m1.1: プロジェクトごとのハーネスパック選択。
//
// 選択状態の正は注入先の注入記録 (.claude/bdboard-packs.json) で、入れた = 選んだ。
// 「入れたいが入っていない」状態は持たず、ここのボタンは押した瞬間に注入する。
// 選べるかどうか (ベース未注入の任意パックなど) の判定はサーバーが返す `injectable`
// を表示するだけで、規則はここに複製しない。パックを外す操作はサーバーが実行せず
// (bdboard が注入先へ書くのは注入 API だけ)、ユーザーが自分の端末で実行するコマンドを
// 表示してコピーさせる。
import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchProjectHarnessStatus,
  fetchProjects,
  type ProjectDto,
  type ProjectHarnessPackStatusDto,
} from '../../api';
import {
  formatHarnessPackStatusLabel,
  harnessHooksNeedAttention,
  harnessInjectButtonLabel,
} from '../../harnessDisplay';
import {
  formatHarnessPackRole,
  formatHarnessPackRoleDetail,
  isHarnessPackSelected,
} from '../../harnessPackSelection';
import { useHarnessFeedback, useHarnessInject } from '../../hooks/useHarnessInject';
import { UninjectCommand } from './HarnessPackUninject';

function PackRow({
  project,
  bdboardRootPath,
  pack,
  pending,
  onInject,
}: {
  readonly project: ProjectDto;
  readonly bdboardRootPath: string | undefined;
  readonly pack: ProjectHarnessPackStatusDto;
  readonly pending: boolean;
  readonly onInject: (pack: ProjectHarnessPackStatusDto) => void;
}) {
  const blockedNoteId = useId();
  const selected = isHarnessPackSelected(pack);
  const canAct = !selected || pack.drift || harnessHooksNeedAttention(pack);
  const blockedReason = pack.injectable.ok ? null : pack.injectable.reason;
  const actionLabel = selected ? harnessInjectButtonLabel(pack) : '選択して注入';

  return (
    <li className="harness-pack-row" data-selected={selected ? 'true' : 'false'}>
      <div className="harness-pack-head">
        <span className="harness-pack-name">{pack.name}</span>
        <span className="settings-panel-badge">{formatHarnessPackRole(pack.role)}</span>
        <span className="harness-pack-version">
          {selected
            ? `選択済み (${formatHarnessPackStatusLabel(pack)})`
            : `未選択 (最新 v${pack.availableVersion})`}
        </span>
        {canAct && (
          <button
            type="button"
            className="harness-pack-action"
            disabled={pending || blockedReason !== null}
            aria-label={`${project.name} に ${pack.name} を${actionLabel}`}
            aria-describedby={blockedReason !== null ? blockedNoteId : undefined}
            onClick={() => {
              onInject(pack);
            }}
          >
            {pending ? '実行中…' : actionLabel}
          </button>
        )}
      </div>
      <p className="harness-pack-description">{pack.description}</p>
      <p className="harness-pack-role-detail">{formatHarnessPackRoleDetail(pack)}</p>
      {blockedReason !== null && (
        <p id={blockedNoteId} className="harness-pack-blocked" role="note">
          選べません: {blockedReason}
        </p>
      )}
      {selected && (
        <UninjectCommand
          projectRootPath={project.rootPath}
          bdboardRootPath={bdboardRootPath}
          pack={pack}
        />
      )}
    </li>
  );
}

function ProjectPacks({ project }: { readonly project: ProjectDto }) {
  const { message, showFeedback } = useHarnessFeedback();
  const query = useQuery({
    queryKey: ['project-harness', project.id],
    queryFn: () => fetchProjectHarnessStatus(project.id),
    // 「外す」はユーザーが端末で実行する。戻ってきたときに必ず取り直して、
    // 注入記録から消えた結果が選択状態に反映されるようにする。
    refetchOnWindowFocus: 'always',
  });
  const injectMutation = useHarnessInject({
    onSuccess: showFeedback,
    onError: showFeedback,
  });

  return (
    <div className="harness-pack-project">
      <div className="settings-panel-section-header">
        <h4>{project.name}</h4>
        <button
          type="button"
          className="harness-pack-action"
          disabled={query.isFetching}
          aria-label={`${project.name} のパック状態を再読み込み`}
          onClick={() => {
            void query.refetch();
          }}
        >
          {query.isFetching ? '読み込み中…' : '再読み込み'}
        </button>
      </div>
      {query.isPending && <p className="settings-panel-empty">読み込み中…</p>}
      {query.isError && (
        <p className="settings-panel-error">パックの状態を読み込めませんでした</p>
      )}
      {query.data !== undefined && query.data.packs.length === 0 && (
        <p className="settings-panel-empty">利用できるパックがありません</p>
      )}
      {query.data !== undefined && query.data.packs.length > 0 && (
        <ul className="harness-pack-list">
          {query.data.packs.map((pack) => (
            <PackRow
              key={pack.name}
              project={project}
              bdboardRootPath={query.data.bdboardRootPath}
              pack={pack}
              pending={injectMutation.isPending}
              onInject={(target) => {
                injectMutation.mutate({ projectId: project.id, pack: target });
              }}
            />
          ))}
        </ul>
      )}
      <p className="settings-panel-feedback" aria-live="polite">
        {message}
      </p>
    </div>
  );
}

export function HarnessPacksSection() {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
  });

  return (
    <section className="settings-panel-section" aria-labelledby="harness-packs-title">
      <h3 id="harness-packs-title">ハーネスパック</h3>
      <p className="settings-panel-subtitle">
        プロジェクトごとに入れるパックを選びます。選択状態はプロジェクトの
        .claude/bdboard-packs.json の注入記録がそのまま正で、画面を開き直しても
        サーバーを再起動しても変わりません。任意パックはベースを入れたプロジェクトでだけ選べます。
      </p>
      {projectsQuery.isPending && <p className="settings-panel-empty">読み込み中…</p>}
      {projectsQuery.isError && (
        <p className="settings-panel-error">プロジェクトを読み込めませんでした</p>
      )}
      {projectsQuery.data?.length === 0 && (
        <p className="settings-panel-empty">プロジェクトがありません</p>
      )}
      {projectsQuery.data?.map((project) => (
        <ProjectPacks key={project.id} project={project} />
      ))}
    </section>
  );
}
