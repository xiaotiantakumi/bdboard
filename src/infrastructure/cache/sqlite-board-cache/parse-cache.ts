import type { CachedProject } from '../../../application/ports/board-cache.js';
import { rowToCachedProject } from './convert.js';
import type { ProjectRow } from './row-types.js';

export interface ParseCacheEntry {
  readonly fingerprint: string;
  readonly entry: CachedProject;
}

export interface ParseCache {
  get(projectId: string): ParseCacheEntry | undefined;
  set(projectId: string, fingerprint: string, entry: CachedProject): void;
  delete(projectId: string): void;
  clear(): void;
}

/**
 * project.id ごとに、既存 fingerprint をキーとして CachedProject のパース結果を保持する。
 * putProject() に渡されたオブジェクトは serializeTickets()/deserializeTickets() を経ておらず、
 * SQLite から読み直した結果と異なる可能性があるため、書き込み時は登録せず無効化だけを行う。
 * これにより次の読み取りで変更された1件だけを再パースすればよい。
 */
export function createParseCache(): ParseCache {
  const map = new Map<string, ParseCacheEntry>();
  return {
    get(projectId) {
      return map.get(projectId);
    },
    set(projectId, fingerprint, entry) {
      map.set(projectId, { fingerprint, entry });
    },
    delete(projectId) {
      map.delete(projectId);
    },
    clear() {
      map.clear();
    },
  };
}

/**
 * bdboard-3c36: listProjects()/listProjectsChunked()/getProject() が row を
 * CachedProject へパースする共通の入口。fingerprint が一致すればパース済み
 * (frozen な) オブジェクトを再利用し、JSON.parse (rowToCachedProject 内の
 * deserializeTickets) を丸ごとスキップする。read.ts の3メソッドから共有する
 * ためここに置く (read.ts 側の行数上限 (max-lines 200) を圧迫しないため)。
 */
export function parseCachedProjectRow(row: ProjectRow, cache: ParseCache): CachedProject | null {
  const cached = cache.get(row.id);
  if (cached !== undefined && cached.fingerprint === row.fingerprint) {
    return cached.entry;
  }
  const entry = rowToCachedProject(row);
  if (entry === null) {
    cache.delete(row.id);
    return null;
  }
  Object.freeze(entry);
  Object.freeze(entry.tickets);
  cache.set(row.id, row.fingerprint, entry);
  return entry;
}
