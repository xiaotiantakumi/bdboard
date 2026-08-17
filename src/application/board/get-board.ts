import { buildBoard, mergeBoards, type Board, type BoardCard } from '../../domain/board.js';
import { compareStrings } from '../../domain/compare.js';
import { filterTicketsByEpic } from '../../domain/epic-closure.js';
import type { LivenessThresholds } from '../../domain/liveness.js';
import type { Project } from '../../domain/project.js';
import type { AgentSession, SessionLink } from '../../domain/session.js';
import type { TicketId } from '../../domain/ticket-id.js';
import type { BoardCache } from '../ports/board-cache.js';

export type BoardViewMode = 'merged' | 'split';

export interface ProjectBoard {
  readonly project: Project;
  readonly board: Board;
  /**
   * closedLimit 適用前の done(closed) レーンの総件数。closedLimit 未指定、または
   * 総件数が上限以下なら board.lanes.done.length と一致する。上限超過分の
   * 「他 N 件」表示に使う(bdboard-3tw.86)。
   */
  readonly closedTotal: number;
  /**
   * closedLimit で切り捨てられ、board.lanes.done には出てこないチケットのID一覧
   * (カード全体ではなくIDのみ)。bdboard-3tw.64 の既知ID自動リンク(web/src/App.tsx の
   * boardTicketIds → isTicketOnBoard)は「ボードに存在するチケットか」でリンクの可否を
   * 判定しており、closedLimit の切り捨てで古い closed チケットへの相互参照リンクが
   * 失われる回帰があった(bdboard-3tw.86 レビュー指摘)。カードは送らずID文字列だけを
   * 追加で載せることでこれを解消する。
   */
  readonly truncatedClosedIds: readonly TicketId[];
}

export interface BoardView {
  readonly mode: BoardViewMode;
  readonly generatedAt: Date;
  /** 常に埋まる(プロジェクトごと。project.rootPath 昇順) */
  readonly projects: readonly ProjectBoard[];
  /** mode==='merged' のときのみ。全プロジェクトを統合した1枚。'split' なら null */
  readonly merged: Board | null;
  /** mode==='merged' のときのみ非null。全プロジェクトの closedTotal 合計 */
  readonly mergedClosedTotal: number | null;
  /** mode==='merged' のときのみ非null。全プロジェクトの truncatedClosedIds の和集合(重複排除) */
  readonly mergedTruncatedClosedIds: readonly TicketId[] | null;
}

export interface GetBoardDeps {
  readonly cache: BoardCache;
  readonly now: Date;
  /** S7/S8 で埋まる。未指定なら空 */
  readonly sessions?: readonly AgentSession[];
  readonly links?: readonly SessionLink[];
  readonly livenessThresholds?: LivenessThresholds;
}

export interface GetBoardOptions {
  /** 指定されたIDのみ。未指定なら全部 */
  readonly projectIds?: readonly string[];
  /** 既定 'merged' */
  readonly mode?: BoardViewMode;
  /**
   * プロジェクトごとの done(closed) レーンの上限件数。closedAt 降順(最近閉じた順)で
   * 上位N件だけを残し、残りは切り捨てる。未指定なら無制限(呼び出し元が明示的に
   * 要求したときだけ切る設計 — /api/tickets/:id や /api/comments/:id のような
   * 「IDでどのチケットでも引ける」必要がある呼び出し元は指定しないことで、古い
   * closed チケットの詳細取得を壊さない)。
   */
  readonly closedLimit?: number;
  /** 指定されたエピック自身と、親子関係にある全子孫のみ表示 */
  readonly epicId?: TicketId;
}

function closedAtTimestamp(card: BoardCard): number {
  return card.ticket.closedAt !== undefined
    ? card.ticket.closedAt.getTime()
    : Number.NEGATIVE_INFINITY;
}

/** closedAt 降順、同値なら ticket.id で安定させる(closedAt が同じミリ秒のテスト/実データ対策) */
function compareClosedAtDescending(a: BoardCard, b: BoardCard): number {
  const diff = closedAtTimestamp(b) - closedAtTimestamp(a);
  if (diff !== 0) {
    return diff;
  }
  return compareStrings(a.ticket.id, b.ticket.id);
}

interface TruncatedBoard {
  readonly board: Board;
  readonly closedTotal: number;
  /** 切り捨てられたチケットのID一覧(closedAt昇順=古い順である必要はない、順不同でよい) */
  readonly truncatedIds: readonly TicketId[];
}

/**
 * epicId 指定時のボード絞り込みは buildBoard より「後」に、カードレベルで行う
 * (bdboard-3tw.95 レビュー M1 修正)。buildBoard 自体はプロジェクトの全チケットで
 * 実行しなければならない — でないと readiness/openBlockerIds
 * (src/domain/readiness.ts)がスコープ外の未知チケットを「存在しないブロッカー」
 * として無視し、エピック外チケットにブロックされている子が blocked から ready へ
 * 化けてしまう(effectivePriority/priorityInheritedFrom/unblocksCount も同様に
 * 壊れる)。truncateClosedLane と同じ「domain の buildBoard/mergeBoards は
 * いじらず application 層で追加加工する」方針に揃えている。
 */
function filterBoardByIdSet(board: Board, idSet: ReadonlySet<TicketId>): Board {
  const cards = board.cards.filter((card) => idSet.has(card.ticket.id));
  const laneEntries = Object.entries(board.lanes) as [
    keyof Board['lanes'],
    readonly BoardCard[],
  ][];
  const lanes = Object.fromEntries(
    laneEntries.map(([lane, laneCards]) => [
      lane,
      laneCards.filter((card) => idSet.has(card.ticket.id)),
    ]),
  ) as unknown as Board['lanes'];

  return { cards, lanes };
}

/**
 * done(closed) レーンだけを closedAt 降順で closedLimit 件に切る。domain の buildBoard/
 * mergeBoards 自体はいじらず application 層で追加加工する(bdboard-3tw.86: ドメイン層の
 * 責務を保つため)。board.cards からも切り捨てた分を除いて cardCount と整合させる。
 */
function truncateClosedLane(board: Board, closedLimit: number): TruncatedBoard {
  const doneCards = board.lanes.done;
  const closedTotal = doneCards.length;

  if (closedTotal <= closedLimit) {
    return { board, closedTotal, truncatedIds: [] };
  }

  const sorted = [...doneCards].sort(compareClosedAtDescending);
  const kept = sorted.slice(0, closedLimit);
  const dropped = sorted.slice(closedLimit);
  const keptIds = new Set(kept.map((card) => card.ticket.id));
  const cards = board.cards.filter(
    (card) => card.lane !== 'done' || keptIds.has(card.ticket.id),
  );

  return {
    board: {
      cards,
      lanes: { ...board.lanes, done: kept },
    },
    closedTotal,
    truncatedIds: dropped.map((card) => card.ticket.id),
  };
}

function humanLabeledIdsFromCache(
  pendingDecisions: readonly { readonly id: TicketId }[] | undefined,
): ReadonlySet<TicketId> {
  if (pendingDecisions === undefined || pendingDecisions.length === 0) {
    return new Set();
  }
  // refreshProjects がキャッシュに載せた pending decisions を読むだけ。
  // 未設定・空なら awaiting_human は空で、通常レーン判定にフォールバックする。
  return new Set(pendingDecisions.map((decision) => decision.id));
}

export async function getBoard(
  deps: GetBoardDeps,
  options?: GetBoardOptions,
): Promise<BoardView> {
  const mode = options?.mode ?? 'merged';
  const projectIdFilter = options?.projectIds;

  let entries = deps.cache.listProjects();
  if (projectIdFilter !== undefined) {
    const filterSet = new Set(projectIdFilter);
    entries = entries.filter((entry) => filterSet.has(entry.project.id));
  }

  const optionalBuildBoardInput = {
    ...(deps.sessions !== undefined ? { sessions: deps.sessions } : {}),
    ...(deps.links !== undefined ? { links: deps.links } : {}),
    ...(deps.livenessThresholds !== undefined
      ? { livenessThresholds: deps.livenessThresholds }
      : {}),
  };

  const closedLimit = options?.closedLimit;
  const epicId = options?.epicId;

  const projects: ProjectBoard[] = entries.map((entry) => {
    const humanLabeledIds = humanLabeledIdsFromCache(entry.pendingDecisions);

    // buildBoard は常にプロジェクトの全チケットで実行する(M1: 上の
    // filterBoardByIdSet の注記を参照)。epicId によるスコープ絞り込みは、
    // readiness/優先度が正しく計算された後にカード単位で適用する。
    const board = buildBoard({
      projectId: entry.project.id,
      tickets: entry.tickets,
      now: deps.now,
      ...optionalBuildBoardInput,
      ...(humanLabeledIds.size > 0 ? { humanLabeledIds } : {}),
    });

    const scopedBoard =
      epicId !== undefined
        ? filterBoardByIdSet(
            board,
            new Set(filterTicketsByEpic(epicId, entry.tickets).map((ticket) => ticket.id)),
          )
        : board;

    const truncated: TruncatedBoard =
      closedLimit !== undefined
        ? truncateClosedLane(scopedBoard, closedLimit)
        : { board: scopedBoard, closedTotal: scopedBoard.lanes.done.length, truncatedIds: [] };

    return {
      project: entry.project,
      board: truncated.board,
      closedTotal: truncated.closedTotal,
      truncatedClosedIds: truncated.truncatedIds,
    };
  });

  const merged =
    mode === 'merged' ? mergeBoards(projects.map((projectBoard) => projectBoard.board)) : null;
  const mergedClosedTotal =
    mode === 'merged'
      ? projects.reduce((sum, projectBoard) => sum + projectBoard.closedTotal, 0)
      : null;
  const mergedTruncatedClosedIds =
    mode === 'merged'
      ? [...new Set(projects.flatMap((projectBoard) => projectBoard.truncatedClosedIds))]
      : null;

  return {
    mode,
    generatedAt: deps.now,
    projects,
    merged,
    mergedClosedTotal,
    mergedTruncatedClosedIds,
  };
}
