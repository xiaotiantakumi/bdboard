import type { Project } from '../../domain/project.js';

export interface ProjectWatchHandle {
  /**
   * 監視対象を projects の集合に差し替える。実装は差分適用してよい(全部作り直す必要はない)。
   * discovery でプロジェクトが増減したときに呼ぶ。
   */
  update(projects: readonly Project[]): Promise<void>;
  /** 監視を停止する */
  stop(): Promise<void>;
}

export interface ProjectWatcher {
  /** 変化を検知したら onChange(projectId) を呼ぶ。戻り値のハンドルで監視対象の更新と停止を行う */
  watch(
    projects: readonly Project[],
    onChange: (projectId: string) => void,
  ): Promise<ProjectWatchHandle>;
}
