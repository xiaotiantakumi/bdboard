// bdboard-sso1.12: dto.ts のモジュール分割。ボードカード・ボード・プロジェクト・
// ボード全体ビューの組み立て DTO。board-routes.ts が参照する (barrel 経由)。
import type { Board, BoardCard } from '../../../domain/board.js';
import { computeLiveness, type LivenessThresholds } from '../../../domain/liveness.js';
import type { Project } from '../../../domain/project.js';
import { LANES } from '../../../domain/readiness.js';
import type { AgentSession } from '../../../domain/session.js';
import type { Ticket } from '../../../domain/ticket.js';
import type { BoardView } from '../../../application/board/get-board.js';
import { toTicketSummaryDto, type TicketSummaryDto } from './shared.js';
import { toSessionDto, type SessionDto } from './session.js';

export interface BoardCardDto {
  ticket: TicketSummaryDto;
  lane: string;
  projectId: string;
  blockedBy: string[];
  blocks: string[];
  unblocksCount: number;
  liveness: string | null;
  sessions: SessionDto[];
  stalled: boolean;
  epicProgress: { total: number; done: number } | null;
  deferDays: number | null;
  deferUrgency: string | null;
  effectivePriority: number;
  priorityInheritedFrom: string | null;
}

export interface BoardDto {
  lanes: Record<string, BoardCardDto[]>;
  cardCount: number;
  /**
   * done(closed) レーンの切り捨て前の総件数。closedLimit が効いて
   * lanes.done.length より大きいときは「他 N 件(非表示)」の算出に使う
   * (bdboard-3tw.86)。
   */
  closedTotal: number;
  /**
   * closedLimit で切り捨てられ、lanes.done には出てこないチケットのID一覧
   * (カード全体ではなくIDのみ)。bdboard-3tw.64 の既知ID自動リンク判定
   * (web/src/App.tsx の boardTicketIds)がこれも「ボード上に存在する」扱いにできるよう
   * 送る(bdboard-3tw.86 回帰対応: 古い closed チケットへの相互参照リンクが
   * closedLimit の切り捨てで失われていた)。
   */
  truncatedClosedIds: string[];
}

export interface ProjectDto {
  id: string;
  name: string;
  rootPath: string;
  prefixes: string[];
  sessionCount: number;
  activeSessionCount: number;
  incompleteTicketCount: number;
  sessions: SessionDto[];
}

export interface ProjectBoardDto {
  project: ProjectDto;
  board: BoardDto;
}

export interface BoardViewDto {
  mode: string;
  generatedAt: string;
  projects: ProjectBoardDto[];
  merged: BoardDto | null;
}

export function toBoardCardDto(
  card: BoardCard,
  now: Date,
  livenessThresholds: LivenessThresholds,
): BoardCardDto {
  return {
    ticket: toTicketSummaryDto(card.ticket),
    lane: card.lane,
    projectId: card.projectId,
    blockedBy: [...card.blockedBy],
    blocks: [...card.blocks],
    unblocksCount: card.unblocksCount,
    liveness: card.liveness,
    sessions: card.sessions.map((session) =>
      toSessionDto(session, now, livenessThresholds),
    ),
    stalled: card.stalled,
    epicProgress:
      card.epicProgress === null
        ? null
        : { total: card.epicProgress.total, done: card.epicProgress.done },
    deferDays: card.deferDays,
    deferUrgency: card.deferUrgency,
    effectivePriority: card.effectivePriority,
    priorityInheritedFrom: card.priorityInheritedFrom,
  };
}

export interface ToBoardDtoOptions {
  readonly closedTotal?: number;
  readonly truncatedClosedIds?: readonly string[];
}

export function toBoardDto(
  board: Board,
  now: Date,
  livenessThresholds: LivenessThresholds,
  options?: ToBoardDtoOptions,
): BoardDto {
  const closedTotal = options?.closedTotal;
  const truncatedClosedIds = options?.truncatedClosedIds;
  const lanes: Record<string, BoardCardDto[]> = {};
  for (const lane of LANES) {
    lanes[lane] = board.lanes[lane].map((card) =>
      toBoardCardDto(card, now, livenessThresholds),
    );
  }

  return {
    lanes,
    cardCount: board.cards.length,
    closedTotal: closedTotal ?? board.lanes.done.length,
    truncatedClosedIds: truncatedClosedIds !== undefined ? [...truncatedClosedIds] : [],
  };
}

export function countIncompleteTicketsFromTickets(
  tickets: readonly Ticket[],
): number {
  return tickets.filter((ticket) => ticket.status !== 'closed').length;
}

export function countIncompleteTicketsFromBoard(board: Board): number {
  return (
    board.lanes.ready.length +
    board.lanes.in_progress.length +
    board.lanes.awaiting_human.length +
    board.lanes.blocked.length
  );
}

export interface ToProjectDtoOptions {
  readonly sessions?: readonly AgentSession[];
  readonly incompleteTicketCount?: number;
}

export function toProjectDto(
  project: Project,
  now: Date,
  livenessThresholds: LivenessThresholds,
  options?: ToProjectDtoOptions,
): ProjectDto {
  const sessions = options?.sessions;
  const incompleteTicketCount = options?.incompleteTicketCount ?? 0;
  const sessionDtos =
    sessions !== undefined
      ? sessions.map((session) => toSessionDto(session, now, livenessThresholds))
      : [];

  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    prefixes: [...project.prefixes],
    sessionCount: sessions !== undefined ? sessions.length : 0,
    activeSessionCount:
      sessions !== undefined
        ? sessions.filter(
            (s) => computeLiveness(now, s, livenessThresholds) === 'active',
          ).length
        : 0,
    incompleteTicketCount,
    sessions: sessionDtos,
  };
}

export function toBoardViewDto(
  view: BoardView,
  livenessThresholds: LivenessThresholds,
  sessionsByProject?: ReadonlyMap<string, readonly AgentSession[]>,
): BoardViewDto {
  const now = view.generatedAt;

  // mode==='merged' では merged が projects の全チケットを既に統合しているので、
  // projects 側もそのままシリアライズすると全チケットが2回送られる(bdboard-3tw.86)。
  // BoardView.projects 自体は application 層の内部表現として常に埋めたままにし
  // (/api/tickets/:id 等 view.merged を経由しない既存の内部利用に影響を与えないため)、
  // ワイヤーに出す直前のこの変換でだけ空にする。
  const projects =
    view.mode === 'merged'
      ? []
      : view.projects.map((projectBoard) => ({
          project: toProjectDto(projectBoard.project, now, livenessThresholds, {
            sessions: sessionsByProject?.get(projectBoard.project.id),
            incompleteTicketCount: countIncompleteTicketsFromBoard(
              projectBoard.board,
            ),
          }),
          board: toBoardDto(projectBoard.board, now, livenessThresholds, {
            closedTotal: projectBoard.closedTotal,
            truncatedClosedIds: projectBoard.truncatedClosedIds,
          }),
        }));

  return {
    mode: view.mode,
    generatedAt: view.generatedAt.toISOString(),
    projects,
    merged:
      view.merged !== null
        ? toBoardDto(view.merged, now, livenessThresholds, {
            closedTotal: view.mergedClosedTotal ?? undefined,
            truncatedClosedIds: view.mergedTruncatedClosedIds ?? undefined,
          })
        : null,
  };
}
