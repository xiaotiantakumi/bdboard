import type { BoardCache } from '../../application/ports/board-cache.js';
import type { Ticket } from '../../domain/ticket.js';

/** キャッシュからチケットと、それが属するプロジェクトの根を引く (bdboard-vgdr)。添付 API とローカルファイル API が共有する。 */
export function findCachedTicket(
  cache: Pick<BoardCache, 'listProjects'>,
  ticketId: string,
): { readonly rootPath: string; readonly ticket: Ticket } | undefined {
  for (const entry of cache.listProjects()) {
    const ticket = entry.tickets.find((t) => t.id === ticketId);
    if (ticket !== undefined) {
      return { rootPath: entry.project.rootPath, ticket };
    }
  }
  return undefined;
}
