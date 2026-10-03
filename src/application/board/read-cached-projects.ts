import type { Project } from '../../domain/project.js';
import type { BoardCache, CachedProject } from '../ports/board-cache.js';

// bdboard-5lnh: BoardCache の「全プロジェクトを読む」入口を1か所にまとめる。
// これまで次の2つの書き方が呼び出し元ごとに複製されていた:
//   - `cache.listProjectsChunked !== undefined ? await cache.listProjectsChunked() : cache.listProjects()`
//     (get-throughput-stats / get-model-stats / get-cfd-stats / get-harness-kpi / stats-routes の5か所)
//   - `cache.listProjects().map((entry) => entry.project)` (14か所)
// 省略可能なポートメソッド (listProjectsChunked / listProjectRefs) を持たないインメモリ fake
// でも同じ結果が返るよう、フォールバックはここだけに置く。

/**
 * チケットまで要る呼び出し元向け。listProjectsChunked() があればそれ (SQLite の読み出しと
 * チケット JSON のパースをプロジェクト単位でチャンク化し、イベントループへ制御を返す)、
 * 無ければ listProjects()。どちらも project.rootPath 昇順で同じ結果を返す (bdboard-mkkx)。
 */
export async function readProjectEntries(
  cache: Pick<BoardCache, 'listProjects' | 'listProjectsChunked'>,
): Promise<readonly CachedProject[]> {
  return cache.listProjectsChunked !== undefined
    ? await cache.listProjectsChunked()
    : cache.listProjects();
}

/**
 * project (定義) だけ要る呼び出し元向け。listProjectRefs() があればそれ (温まっていれば
 * チケットのテキストに触れない)、無ければ listProjects().map((entry) => entry.project)。
 * どちらも project.rootPath 昇順で同じ結果を返す。
 */
export function readProjectRefs(
  cache: Pick<BoardCache, 'listProjects' | 'listProjectRefs'>,
): readonly Project[] {
  return cache.listProjectRefs !== undefined
    ? cache.listProjectRefs()
    : cache.listProjects().map((entry) => entry.project);
}
