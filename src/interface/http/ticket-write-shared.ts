import type { BoardCache } from '../../application/ports/board-cache.js';
import type { Ticket } from '../../domain/ticket.js';
import type { ApiDeps } from './api-deps.js';

/**
 * ticket-write-routes.ts (旧511行, チケット書き込み系12ルートが同居) をリソース別の
 * ルートモジュールへ分割した際(bdboard-sso1.25)の共有ヘルパー。複数の書き込みグループ
 * から使われるものだけをここに置く。1グループでしか使わないヘルパー・zod スキーマは
 * そのグループのルートファイルに置く (routes.ts 分割 bdboard-sso1.1 と同じ方針)。
 */

export function findProjectRootPathForTicket(
  cache: BoardCache,
  ticketId: string,
): string | undefined {
  for (const entry of cache.listProjects()) {
    if (entry.tickets.some((ticket) => ticket.id === ticketId)) {
      return entry.project.rootPath;
    }
  }
  return undefined;
}

export function findCachedTicket(
  cache: BoardCache,
  ticketId: string,
): { readonly rootPath: string; readonly ticket: Ticket } | undefined {
  for (const entry of cache.listProjects()) {
    const ticket = entry.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) {
      return { rootPath: entry.project.rootPath, ticket };
    }
  }
  return undefined;
}

/**
 * 書き込み成功後、そのプロジェクトだけを強制リフレッシュしてから応答する。
 * これが無いと UI が応答直後に再取得しても書き込み前のキャッシュが返り、
 * 「操作が効いていない」ように見える(bdboard-6qs6)。
 * リフレッシュの失敗で書き込み自体を失敗扱いにはしない — bd への書き込みは
 * 既に成功しているので、ここで 5xx を返すと利用者が二重に操作しかねない。
 *
 * deps だけに依存する純粋な関数で、呼び出しをまたいで共有する状態は無い
 * (api-route-shared.ts の createInFlightOverlapMemo と違い、書き込みグループごとに
 * 毎回作って構わない)。
 */
export function createRefreshAfterWrite(
  deps: ApiDeps,
): (rootPath: string) => Promise<void> {
  return async (rootPath: string): Promise<void> => {
    if (deps.refreshProjectByRootPath === undefined) {
      return;
    }
    try {
      await deps.refreshProjectByRootPath(rootPath);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`post-write refresh failed (rootPath=${rootPath}): ${detail}`);
    }
  };
}
