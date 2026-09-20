import type { BoardCache, CachedProject } from '../../application/ports/board-cache.js';
import type { RunMode } from '../../domain/run.js';
import type { Ticket } from '../../domain/ticket.js';
import type { RunStoreRecord } from '../../application/runner/run-store.js';

/**
 * agent-run-routes.ts (旧672行, エージェント実行系4ルートが同居) をリソース別の
 * ルートモジュールへ分割した際(bdboard-sso1.27)の共有ヘルパー。複数のルートグループ
 * から使われるものだけをここに置く。1グループでしか使わないヘルパー・型は
 * そのグループのルートファイルに置く (ticket-write-shared.ts 分割 bdboard-sso1.25 と
 * 同じ方針)。
 *
 * - findTicket / ResolvedTicket: 作成ルート (agent-run-create-routes.ts) と
 *   読み取りルートの詳細取得 (agent-run-read-routes.ts の resolveRunNextStep) の
 *   両方から使う。
 * - toRunSummaryDto / RunSummaryDto: 読み取りルートの一覧・詳細の両方から使う。
 */

export interface ResolvedTicket {
  readonly project: CachedProject['project'];
  readonly ticket: Ticket;
  readonly cleanupEligibleTicketIds: readonly string[];
}

export function findTicket(cache: BoardCache, ticketId: string): ResolvedTicket | undefined {
  for (const entry of cache.listProjects()) {
    const ticket = entry.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) {
      return {
        project: entry.project,
        ticket,
        cleanupEligibleTicketIds: entry.tickets
          .filter((candidate) => candidate.status === 'closed')
          .map((candidate) => candidate.id),
      };
    }
  }
  return undefined;
}

export interface RunSummaryDto {
  readonly id: string;
  readonly ticketId: string;
  readonly runner: string;
  readonly mode: RunMode;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

export function toRunSummaryDto(record: RunStoreRecord): RunSummaryDto {
  return {
    id: record.id,
    ticketId: record.ticketId,
    runner: record.runner,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString(),
    exitCode: record.exitCode,
    error: record.error,
  };
}
