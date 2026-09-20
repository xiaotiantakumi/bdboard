import type { ProjectDto } from '../../api';

interface ChatProjectBarProps {
  showProjectSelect: boolean;
  selectedProjectId: string;
  isSending: boolean;
  projectSelectionHintId: string | null;
  onProjectSelectChange: (projectId: string) => void;
  projects: readonly ProjectDto[];
  selectedProjectName: string | undefined;
  projectSelectionHint: string | null;
  ticketProjectFallbackNotice: string | null;
}

/**
 * bdboard-r5we: 対象プロジェクトはチャット設定(details)の中に畳まれていて
 * 既定では見えなかった。送信先はチャットの最重要文脈なので、details の外の
 * 常時表示行へ出す。
 * レビュー major-1: 描画条件を projects.length ではなく「選択が必要か」で
 * 決める。送信可否(selectedProjectId === '')と条件を揃えないと、
 * 「1件だけ到着したがチケットのプロジェクトと違う」経路で select が出ない
 * まま送信が永久 disabled になり、脱出手段が無くなる。
 */
export function ChatProjectBar({
  showProjectSelect,
  selectedProjectId,
  isSending,
  projectSelectionHintId,
  onProjectSelectChange,
  projects,
  selectedProjectName,
  projectSelectionHint,
  ticketProjectFallbackNotice,
}: ChatProjectBarProps) {
  return (
    <div className="chat-project-bar">
      {showProjectSelect ? (
        <label className="chat-project-bar-label" htmlFor="chat-project-select">
          対象プロジェクト
        </label>
      ) : (
        <span className="chat-project-bar-label">対象プロジェクト</span>
      )}
      {showProjectSelect ? (
        <select
          id="chat-project-select"
          className="chat-project-select"
          value={selectedProjectId}
          disabled={isSending}
          aria-describedby={
            projectSelectionHintId === null ? undefined : projectSelectionHintId
          }
          onChange={(event) => onProjectSelectChange(event.target.value)}
        >
          {selectedProjectId === '' && <option value="">プロジェクトを選択…</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      ) : (
        <p className="chat-project-name">{selectedProjectName ?? '—'}</p>
      )}
      {/* .chat-input-notices と同じ: 条件式でラッパーを消さず :empty に任せ、gap の二重管理を避ける。 */}
      <div className="chat-project-bar-notices">
        {projectSelectionHint !== null && (
          <p
            className="chat-project-unselected-hint"
            id="chat-project-unselected-hint"
            role="status"
          >
            {projectSelectionHint}
          </p>
        )}
        {ticketProjectFallbackNotice !== null && (
          <p className="chat-ticket-project-fallback-notice" role="status">
            {ticketProjectFallbackNotice}
          </p>
        )}
      </div>
    </div>
  );
}
