import { join, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { debounceByKey } from '../../application/board/debounce-by-key.js';
import type {
  ProjectWatchHandle,
  ProjectWatcher,
} from '../../application/ports/project-watcher.js';
import type { Project } from '../../domain/project.js';

const DEFAULT_DEBOUNCE_MS = 300;

function beadsWatchPaths(rootPath: string): string[] {
  const beadsDir = join(rootPath, '.beads');
  return [
    join(beadsDir, 'last-touched'),
    join(beadsDir, 'interactions.jsonl'),
    join(beadsDir, 'embeddeddolt'),
  ];
}

function findProjectId(
  eventPath: string,
  pathToProjectId: ReadonlyMap<string, string>,
  watchPaths: readonly string[],
): string | undefined {
  if (pathToProjectId.has(eventPath)) {
    return pathToProjectId.get(eventPath);
  }

  // embeddeddolt/ 配下の子ファイルなど、監視パスの「下」で起きたイベントを拾う。
  // `last-touched-2` のような兄弟パスに誤マッチしないよう、区切り文字まで含めて比較する。
  for (const watchPath of watchPaths) {
    if (eventPath.startsWith(`${watchPath}${sep}`)) {
      return pathToProjectId.get(watchPath);
    }
  }

  return undefined;
}

function buildPathMap(projects: readonly Project[]): Map<string, string> {
  const pathToProjectId = new Map<string, string>();

  for (const project of projects) {
    for (const path of beadsWatchPaths(project.rootPath)) {
      pathToProjectId.set(path, project.id);
    }
  }

  return pathToProjectId;
}

export function createChokidarProjectWatcher(
  options?: { readonly debounceMs?: number },
): ProjectWatcher {
  const debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  return {
    async watch(
      projects: readonly Project[],
      onChange: (projectId: string) => void,
    ): Promise<ProjectWatchHandle> {
      // 起動時のプロジェクトが0件でも FSWatcher は作る。あとから update() で
      // 監視対象を足せるようにするため(以前はここで no-op ハンドルを返しており、
      // 起動後に見つかったプロジェクトが永久に監視されなかった)。
      let pathToProjectId: ReadonlyMap<string, string> = new Map<string, string>();
      let watchPaths: readonly string[] = [];

      const debounced = debounceByKey<string>((projectId) => {
        onChange(projectId);
      }, debounceMs);

      const watcher: FSWatcher = watch([], { ignoreInitial: true });

      watcher.on('all', (_event, path) => {
        const projectId = findProjectId(path, pathToProjectId, watchPaths);
        if (projectId !== undefined) {
          debounced.trigger(projectId);
        }
      });

      const handle: ProjectWatchHandle = {
        async update(nextProjects: readonly Project[]): Promise<void> {
          const nextPathToProjectId = buildPathMap(nextProjects);

          const toAdd = [...nextPathToProjectId.keys()].filter(
            (path) => !pathToProjectId.has(path),
          );
          const toRemove = [...pathToProjectId.keys()].filter(
            (path) => !nextPathToProjectId.has(path),
          );

          // イベントハンドラが参照するマップを先に差し替える。unwatch は非同期に
          // 効くので、外れたプロジェクトのイベントはマップ側でも落とせるようにしておく。
          pathToProjectId = nextPathToProjectId;
          watchPaths = [...nextPathToProjectId.keys()];

          if (toRemove.length > 0) {
            watcher.unwatch(toRemove);
          }
          if (toAdd.length > 0) {
            watcher.add(toAdd);
          }
        },

        async stop(): Promise<void> {
          debounced.cancel();
          await watcher.close();
        },
      };

      await handle.update(projects);

      return handle;
    },
  };
}
