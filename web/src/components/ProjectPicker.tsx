import { useEffect, useMemo, useState } from 'react';
import type { ProjectDto } from '../api';
import { useExclusivePopover } from './PopoverCoordinator';

/*
  Header Redesign Turn 4 / 4a。プロジェクト選択は <details> のインライン展開をやめ、
  GlobalBar の上に重なるポップオーバーにする。開閉でヘッダーの高さも各ボタンの位置も
  動かさないことと、ボタン幅を選択内容で変えないことが要件。
*/

/** 検索欄を出す最小プロジェクト数(これ未満なら目視で足りるので出さない)。 */
export const PROJECT_PICKER_SEARCH_THRESHOLD = 3;

export interface ProjectPickerProps {
  projects: ProjectDto[];
  selectedProjectIds: string[];
  onToggleProject: (projectId: string, checked: boolean) => void;
  onSelectAllProjects: () => void;
  onClearAllProjects: () => void;
  onSaveCombination: () => void;
}

/**
 * ヘッダーボタンのラベル。選択が増えても「他N件」で吸収し、幅は CSS 側で固定する。
 * 未選択(= 絞り込み無し)と全選択はどちらも盤面上は同じ意味なので同じ文言にする。
 */
export function projectPickerLabel(
  projects: readonly ProjectDto[],
  selectedProjectIds: readonly string[],
): string {
  const selected = projects.filter((project) => selectedProjectIds.includes(project.id));
  if (selected.length === 0 || selected.length === projects.length) {
    return 'すべてのプロジェクト';
  }
  const [first, ...rest] = selected;
  return rest.length === 0 ? first.name : `${first.name} 他${rest.length}件`;
}

export function ProjectPicker({
  projects,
  selectedProjectIds,
  onToggleProject,
  onSelectAllProjects,
  onClearAllProjects,
  onSaveCombination,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useExclusivePopover('project-picker', open, setOpen);

  // 閉じたら検索文字列を捨てる。次に開いたときに前回の絞り込みが残っていると、
  // 空のリストがいきなり出てプロジェクトが消えたように見えるため。
  useEffect(() => {
    if (!open) {
      setQuery('');
    }
  }, [open]);

  const label = projectPickerLabel(projects, selectedProjectIds);
  const showSearch = projects.length >= PROJECT_PICKER_SEARCH_THRESHOLD;

  const { selectedGroup, otherGroup, matchCount } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched =
      needle === ''
        ? projects
        : projects.filter((project) => project.name.toLowerCase().includes(needle));
    return {
      selectedGroup: matched.filter((project) => selectedProjectIds.includes(project.id)),
      otherGroup: matched.filter((project) => !selectedProjectIds.includes(project.id)),
      matchCount: matched.length,
    };
  }, [projects, selectedProjectIds, query]);

  // 未選択は「全件表示」なので、表示中の件数は全件になる。
  const shownCount =
    selectedProjectIds.length === 0
      ? projects.length
      : projects.filter((project) => selectedProjectIds.includes(project.id)).length;

  const renderRow = (project: ProjectDto) => {
    const checked = selectedProjectIds.includes(project.id);
    return (
      <button
        key={project.id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        className={`project-picker-row${checked ? ' project-picker-row-selected' : ''}`}
        onClick={() => onToggleProject(project.id, !checked)}
      >
        <span className="project-picker-check" aria-hidden="true">
          {checked ? '✓' : ''}
        </span>
        <span className="project-picker-name">{project.name}</span>
      </button>
    );
  };

  return (
    <div ref={containerRef} className="project-picker header-group">
      <button
        type="button"
        className="project-picker-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`プロジェクトの絞り込み: ${label}`}
        onClick={() => setOpen(!open)}
      >
        <span className="project-picker-button-label">{label}</span>
        <span className="project-picker-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && (
        <div className="project-picker-popover" role="dialog" aria-label="プロジェクトの絞り込み">
          <div className="popover-head">
            {showSearch && (
              <input
                type="text"
                className="project-picker-search"
                placeholder="プロジェクトを検索"
                aria-label="プロジェクトを検索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
            <div className="project-picker-summary">
              <span className="project-picker-count">
                {shownCount} / {projects.length} 件を表示中
              </span>
              <span className="project-picker-bulk">
                <button type="button" className="link-btn" onClick={onSelectAllProjects}>
                  すべて
                </button>
                <span className="project-picker-bulk-sep" aria-hidden="true">
                  |
                </span>
                <button type="button" className="link-btn" onClick={onClearAllProjects}>
                  解除
                </button>
              </span>
            </div>
          </div>

          <div className="project-picker-list">
            {selectedGroup.length > 0 && (
              <p className="project-picker-group-label">選択中</p>
            )}
            {selectedGroup.map(renderRow)}
            {otherGroup.length > 0 && <p className="project-picker-group-label">その他</p>}
            {otherGroup.map(renderRow)}
            {matchCount === 0 && (
              <p className="project-picker-empty">該当するプロジェクトがありません</p>
            )}
          </div>

          <div className="popover-foot">
            <button
              type="button"
              className="btn btn-small project-picker-save"
              onClick={() => {
                setOpen(false);
                onSaveCombination();
              }}
            >
              この組み合わせを保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
