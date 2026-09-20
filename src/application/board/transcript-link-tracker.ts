import { compareStrings } from '../../domain/compare.js';
import type { SessionLink } from '../../domain/session.js';
import { MAX_TRANSCRIPT_SESSION_LINKS } from '../../domain/session.js';
import { parseTicketId } from '../../domain/ticket-id.js';
import type { BoardCache, CachedProject, SessionLinkRow } from '../ports/board-cache.js';

/**
 * bdboard-sso1.9: src/main.ts (composition root) から transcript link の
 * インメモリ集計ロジックを移動しただけ (move only, 挙動変更ゼロ)。元の実装は
 * main() 内のローカル変数・クロージャ (`transcriptLinkMap` / `linkKey` /
 * `trimTranscriptLinksToCap` / `persistTranscriptLinks` / `mergeTranscriptLinks` /
 * `listTranscriptLinks` / `hydrateTranscriptLinksFromCache` / `projectIdForTicketId`) だった。
 */

const LINK_KEY_SEP = '\0';

function linkKey(link: SessionLink): string {
  return `${link.ticketId}${LINK_KEY_SEP}${link.sessionId}`;
}

/** ticketId のプレフィックス(例: "bdboard-3tw.83" -> "bdboard")から所属プロジェクトを引く */
function projectIdForTicketId(
  ticketId: string,
  projects: readonly CachedProject[],
): string | undefined {
  let prefix: string;
  try {
    prefix = parseTicketId(ticketId).prefix;
  } catch {
    return undefined;
  }

  const match = projects.find((entry) => entry.project.prefixes.includes(prefix));
  return match?.project.id;
}

export interface TranscriptLinkTrackerDeps {
  readonly cache: Pick<BoardCache, 'listProjects' | 'upsertSessionLinks' | 'listSessionLinks'>;
  /** 既定 MAX_TRANSCRIPT_SESSION_LINKS (5000)。テストで小さい値に差し替えられるように。 */
  readonly maxLinks?: number;
}

export interface TranscriptLinkTracker {
  /**
   * 再起動でのリンク恒久消失を防ぐため、走査で得た新規/更新リンクは即座に SQLite にも
   * upsert する(cache.setTranscriptOffset() は S8 から永続化済みだったが、リンク自体は
   * これまでインメモリのみだった非対称の是正。bdboard-3tw.83)。
   *
   * 新規リンクが1件でもあれば true を返す(呼び出し元の board.changed 発行判定に使う)。
   */
  merge(newLinks: readonly SessionLink[]): boolean;
  list(): readonly SessionLink[];
  /**
   * 起動時に SQLite の session_links から状態を再構築する。走査位置
   * (transcript_offsets)は既に永続化されているため、これをやらないと再起動のたびに
   * 過去のリンクが読み直されずに失われる(bdboard-3tw.83)。
   */
  hydrateFromCache(): void;
  /** 現在保持しているリンク件数。ログ用途 (main.ts の起動ログ)。 */
  size(): number;
}

export function createTranscriptLinkTracker(
  deps: TranscriptLinkTrackerDeps,
): TranscriptLinkTracker {
  const maxLinks = deps.maxLinks ?? MAX_TRANSCRIPT_SESSION_LINKS;
  const transcriptLinkMap = new Map<string, SessionLink>();

  const trimToCap = (): void => {
    if (transcriptLinkMap.size <= maxLinks) {
      return;
    }

    const sorted = [...transcriptLinkMap.entries()].sort(
      (a, b) => a[1].observedAt.getTime() - b[1].observedAt.getTime(),
    );
    const excess = transcriptLinkMap.size - maxLinks;
    for (let index = 0; index < excess; index += 1) {
      const entry = sorted[index];
      if (entry !== undefined) {
        transcriptLinkMap.delete(entry[0]);
      }
    }
  };

  const persistLinks = (links: readonly SessionLink[]): void => {
    if (links.length === 0) {
      return;
    }

    const projects = deps.cache.listProjects();
    const rows: SessionLinkRow[] = [];
    for (const link of links) {
      const projectId = projectIdForTicketId(link.ticketId, projects);
      if (projectId === undefined) {
        continue;
      }
      rows.push({ projectId, link });
    }

    if (rows.length > 0) {
      deps.cache.upsertSessionLinks(rows);
    }
  };

  return {
    merge(newLinks: readonly SessionLink[]): boolean {
      let hasNew = false;

      for (const link of newLinks) {
        const key = linkKey(link);
        if (!transcriptLinkMap.has(key)) {
          hasNew = true;
        }
        transcriptLinkMap.set(key, link);
      }

      trimToCap();
      persistLinks(newLinks);
      return hasNew;
    },

    list(): readonly SessionLink[] {
      return [...transcriptLinkMap.values()].sort((a, b) => {
        const ticketCmp = compareStrings(a.ticketId, b.ticketId);
        if (ticketCmp !== 0) {
          return ticketCmp;
        }
        return compareStrings(a.sessionId, b.sessionId);
      });
    },

    hydrateFromCache(): void {
      for (const row of deps.cache.listSessionLinks()) {
        transcriptLinkMap.set(linkKey(row.link), row.link);
      }
      trimToCap();
    },

    size(): number {
      return transcriptLinkMap.size;
    },
  };
}
