import type { Project } from '../../domain/project.js';
import type { BoardCache } from '../ports/board-cache.js';
import type { ProjectWatchHandle } from '../ports/project-watcher.js';

export interface SyncWatchedProjectsDeps {
  /** 現在のプロジェクト一覧の出どころ(リフレッシュ後のキャッシュ) */
  readonly cache: Pick<BoardCache, 'listProjects'>;
  readonly handle: ProjectWatchHandle;
  /** watch() 開始時に既に渡してあるプロジェクト。冗長な update を1回省くためだけの情報 */
  readonly initialProjects?: readonly Project[];
}

export interface WatchedProjectsSync {
  /**
   * キャッシュ上のプロジェクト集合を watcher に反映する。
   * 前回反映した集合と同じなら何もしない。反映したら true を返す。
   */
  sync(): Promise<boolean>;
}

/** 監視対象として意味を持つのは id と rootPath だけ(rootPath から監視パスが決まる) */
function watchKey(projects: readonly Project[]): string {
  return [...projects]
    .map((project) => [project.id, project.rootPath].join(' -> '))
    .sort()
    .join('\n');
}

/**
 * discovery で増減したプロジェクトを ProjectWatchHandle に反映する係。
 *
 * 起動時の一覧で監視対象が固定されると、あとから現れたプロジェクトの変更は
 * 定期リフレッシュ(既定5分)まで画面に出ない。リフレッシュ完了のたびに sync() を
 * 呼ぶことで、新しいプロジェクトも既存プロジェクトと同じ即時反映に揃える (bdboard-3tw.85)。
 */
export function createWatchedProjectsSync(
  deps: SyncWatchedProjectsDeps,
): WatchedProjectsSync {
  let lastKey = watchKey(deps.initialProjects ?? []);

  return {
    async sync(): Promise<boolean> {
      const projects = deps.cache.listProjects().map((entry) => entry.project);
      const key = watchKey(projects);

      if (key === lastKey) {
        return false;
      }

      lastKey = key;
      await deps.handle.update(projects);
      return true;
    },
  };
}
