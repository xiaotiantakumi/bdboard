import type Database from 'better-sqlite3';
import type { CachedProject } from '../../../application/ports/board-cache.js';
import type { ProjectRow } from './row-types.js';
import { parseCachedProjectRow, type ParseCache } from './parse-cache.js';

// bdboard-5lnh: listProjects() (同期) / listProjectsChunked() (非同期・yield あり) /
// listProjectRefs() (同期・project だけ) が共有する「全プロジェクトを順に解決する」手順。
// 以前は同期版だけが `SELECT * FROM projects` で全チケットの JSON テキストを毎回 SQLite
// から JS 文字列へコピーしていた (parseCache が温まっていても。実測 200k 件で warm
// 163〜179ms、chunked の warm は 6〜13ms)。ここでは次の2段に分ける:
//   (1) `SELECT id, fingerprint ... ORDER BY root_path ASC` で (id, fingerprint) の組
//       (ProjectKey) だけを一括取得
//   (2) key ごとに parseCache を引き、fingerprint が一致すればそのまま返す。外れた
//       (= 未パース / putProject 等で無効化された / fingerprint が変わった) 分だけ
//       getProjectStmt.get(id) で行を1件読んでパースする
// 戻り値の順序は (1) の ORDER BY root_path ASC で決まるので、従来の SELECT * と同じ。
// 壊れた行 (prefixes / tickets の JSON が不正) は resolve() が null を返し、呼び出し側が
// 飛ばす (parseCachedProjectRow が console.warn して parseCache から外す)。

// ポートの listProjectRefs() (Project[] を返す) と紛らわしくないよう、ここでは Key と呼ぶ。
export interface ProjectKey {
  readonly id: string;
  readonly fingerprint: string;
}

export interface ProjectListing {
  /** root_path 昇順の (id, fingerprint) 一覧。チケット JSON は読まない。 */
  listKeys(): readonly ProjectKey[];
  /**
   * 1件を解決する。parseCache が fingerprint 付きでヒットすれば DB の行を読まずに
   * パース済み (frozen) のオブジェクトを返す。外れたら行を1件だけ読んでパースする。
   * listKeys() のあとで行が消えた / 壊れていた場合は null。
   */
  resolve(key: ProjectKey): CachedProject | null;
}

export function createProjectListing(
  db: Database.Database,
  getProjectStmt: Database.Statement,
  parseCache: ParseCache,
): ProjectListing {
  const listKeysStmt = db.prepare(`SELECT id, fingerprint FROM projects ORDER BY root_path ASC`);

  return {
    listKeys(): readonly ProjectKey[] {
      return listKeysStmt.all() as ProjectKey[];
    },

    resolve(key: ProjectKey): CachedProject | null {
      const cached = parseCache.get(key.id);
      if (cached !== undefined && cached.fingerprint === key.fingerprint) {
        return cached.entry;
      }
      const row = getProjectStmt.get(key.id) as ProjectRow | undefined;
      return row === undefined ? null : parseCachedProjectRow(row, parseCache);
    },
  };
}
