import { compareStrings } from '../../domain/compare.js';
import { KNOWN_COMPLEXITY_ORDER } from '../../domain/ticket-complexity.js';
import { findImplementModel } from '../../domain/ticket-model.js';
import type { Ticket } from '../../domain/ticket.js';
import { forEachChunked } from './aggregation-yield.js';
import {
  isFixPushStatsTarget,
  type FixPushLookup,
  type FixPushLookupResult,
} from './fix-push-lookup-types.js';

/**
 * 複雑度 (`bdboard.complexity`) × 実装モデル (`bdboard.model.implement`) の1行 (bdboard-p5l.27)。
 *
 * complexity / model が null の行は「そのメタデータが未記録のチケット」の行 (UI は「未記録」と
 * 表示する)。集計から落とさず、別の行として数える。
 */
export interface ComplexityModelRow {
  /** null = `bdboard.complexity` 未記録。 */
  readonly complexity: string | null;
  /** null = `bdboard.model.implement` 未記録。 */
  readonly model: string | null;
  /** この行に入るクローズ済みチケット数。 */
  readonly ticketCount: number;
  /** 修正 push 回数が分かったチケット数。 */
  readonly fixPushKnownCount: number;
  /** 分かったチケットの修正 push 回数の合計。 */
  readonly fixPushTotal: number;
  /** 修正 push 回数が分からないチケット数 (= ticketCount - fixPushKnownCount)。 */
  readonly fixPushUnknownCount: number;
  /** fixPushTotal / fixPushKnownCount。分かったチケットが 0 件なら null。 */
  readonly fixPushAverage: number | null;
}

export interface ComplexityModelStats {
  readonly rows: readonly ComplexityModelRow[];
  /**
   * 複雑度も実装モデルも未記録のクローズ済みチケット数。行には含めない (全部を
   * (未記録, 未記録) の1行に積むと、過去の全チケットの PR を引き当てる必要が出るため)。
   */
  readonly unrecordedTicketCount: number;
  /** 引き当てがまだ済んでいない (先読み待ちの) チケット数。0 でなければ後で値が変わりうる。 */
  readonly fixPushPendingCount: number;
}

interface MutableRow {
  readonly complexity: string | null;
  readonly model: string | null;
  ticketCount: number;
  fixPushKnownCount: number;
  fixPushTotal: number;
  fixPushUnknownCount: number;
}

const NOT_LOOKED_UP: FixPushLookupResult = { kind: 'unknown', pending: false };

function complexityRank(complexity: string): number {
  const index = (KNOWN_COMPLEXITY_ORDER as readonly string[]).indexOf(complexity);
  return index === -1 ? KNOWN_COMPLEXITY_ORDER.length : index;
}

/** 既知の複雑度 (low → med → high) → その他 (文字列順) → 未記録 (null) の順。 */
function compareComplexity(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1;
  }
  const rankDiff = complexityRank(a) - complexityRank(b);
  return rankDiff !== 0 ? rankDiff : compareStrings(a, b);
}

function compareModel(a: string | null, b: string | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1;
  }
  return compareStrings(a, b);
}

function toRow(row: MutableRow): ComplexityModelRow {
  return {
    complexity: row.complexity,
    model: row.model,
    ticketCount: row.ticketCount,
    fixPushKnownCount: row.fixPushKnownCount,
    fixPushTotal: row.fixPushTotal,
    fixPushUnknownCount: row.fixPushUnknownCount,
    fixPushAverage:
      row.fixPushKnownCount > 0 ? row.fixPushTotal / row.fixPushKnownCount : null,
  };
}

/**
 * クローズ済みチケットを (複雑度, 実装モデル) ごとに数え、修正 push 回数を join する。
 *
 * - 複雑度または実装モデルの一方だけ未記録のチケットは、未記録の側を null にした行に入る。
 * - 両方未記録のチケットは行に入れず unrecordedTicketCount に数える。
 * - lookup が無い (gh を使えない構成) / 引き当てが済んでいないチケットは「修正 push 回数
 *   不明」として数え、行そのものは落とさない。
 *
 * 期間 (週数) では絞らない: 工程×モデルの分布 (countStageModelDistribution) と同じく
 * 全クローズ済みチケットが対象。メタデータの記録が始まったのが最近なので実質同じ範囲に
 * なる。
 */
export async function countComplexityModelRows(
  tickets: readonly Ticket[],
  lookup?: FixPushLookup,
): Promise<ComplexityModelStats> {
  const rows = new Map<string, MutableRow>();
  let unrecordedTicketCount = 0;
  let fixPushPendingCount = 0;

  await forEachChunked(tickets, (ticket) => {
    if (ticket.closedAt === undefined) {
      return;
    }
    if (!isFixPushStatsTarget(ticket)) {
      unrecordedTicketCount += 1;
      return;
    }

    const complexity = ticket.complexity ?? null;
    const model = findImplementModel(ticket.models) ?? null;
    const key = JSON.stringify([complexity, model]);
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        complexity,
        model,
        ticketCount: 0,
        fixPushKnownCount: 0,
        fixPushTotal: 0,
        fixPushUnknownCount: 0,
      };
      rows.set(key, row);
    }

    row.ticketCount += 1;
    const result = lookup === undefined ? NOT_LOOKED_UP : lookup(ticket);
    if (result.kind === 'known') {
      row.fixPushKnownCount += 1;
      row.fixPushTotal += result.count;
      return;
    }
    row.fixPushUnknownCount += 1;
    if (result.pending) {
      fixPushPendingCount += 1;
    }
  });

  const sorted = [...rows.values()].sort(
    (a, b) => compareComplexity(a.complexity, b.complexity) || compareModel(a.model, b.model),
  );

  return {
    rows: sorted.map(toRow),
    unrecordedTicketCount,
    fixPushPendingCount,
  };
}
