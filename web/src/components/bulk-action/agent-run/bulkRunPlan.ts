// bdboard-mkm1.2: 一括操作バーの「▶ 実行」で、選択中のカードのうちどれを・どの順で
// エージェント実行するかを決める純関数群。React に依存しない。
//
// 実行ループ本体 (../../nextUpRunLoop の useNextUpRunLoopController) はチケット ID の
// 配列を受け取るだけなので、ここではその配列 (runTicketIds) と、確認ダイアログに出す
// 「対象外の件数と理由」、ハーネスの前提未達の理由を組み立てる。
import {
  type BoardCardDto,
  type BoardViewDto,
  type ProjectHarnessStatusDto,
  projectNameFallback,
} from '../../../api';
import { describeHarnessRunBlock } from '../../agentRunShared';

/** 対象外にした理由。並び順はダイアログでの表示順でもある。 */
export const BULK_RUN_EXCLUSION_REASONS = ['epic', 'blocked', 'not-ready', 'missing'] as const;
export type BulkRunExclusionReason = (typeof BULK_RUN_EXCLUSION_REASONS)[number];

/** Record なので理由が増えたら型エラーで気づける。 */
export const BULK_RUN_EXCLUSION_LABELS: Record<BulkRunExclusionReason, string> = {
  epic: 'epic',
  blocked: 'ブロック中',
  'not-ready': '着手可能レーン以外',
  missing: 'ボード上に見つからない',
};

export interface BulkRunExclusion {
  readonly reason: BulkRunExclusionReason;
  readonly count: number;
}

export interface BulkRunPlan {
  /** 実行順 (表示順 = 優先度順) に並べた対象カード。 */
  readonly runCards: readonly BoardCardDto[];
  /** runCards の ID。実行ループへそのまま渡す。 */
  readonly runTicketIds: readonly string[];
  /** 件数 > 0 の理由だけを BULK_RUN_EXCLUSION_REASONS の順で並べたもの。 */
  readonly exclusions: readonly BulkRunExclusion[];
  readonly excludedCount: number;
}

/**
 * 1 枚のカードが実行対象外になる理由を返す (対象なら null)。
 * epic はどのレーンにあっても着手単位ではないので最優先で epic と数える。
 * 着手可能 (ready) 以外のレーンのうち、ブロック (blocked) だけは理由を分けて出す。
 * 選択は Provider がビューをまたいで保持するので、プロジェクトの絞り込みなどで
 * ボードから消えたカードの ID も残りうる (missing)。
 */
export function classifyBulkRunCard(
  card: BoardCardDto | undefined,
): BulkRunExclusionReason | null {
  if (card === undefined) {
    return 'missing';
  }
  if (card.ticket.issueType === 'epic') {
    return 'epic';
  }
  if (card.lane === 'blocked') {
    return 'blocked';
  }
  if (card.lane !== 'ready') {
    return 'not-ready';
  }
  return null;
}

/**
 * 着手可能レーンのカード ID を画面の表示順で並べる。board.merged は統合ビュー
 * 削除 (bdboard-mkm1.1) 後もサーバー DTO 互換のため残っているので、
 * merged → 各プロジェクト (画面上のセクション順) の順に見て、初めて出てきた
 * 位置を採る。レーン内の並びはサーバーの compareCards の順で、クライアントは
 * 並べ替えない。
 */
export function collectReadyDisplayOrder(board: BoardViewDto | undefined): string[] {
  if (board === undefined) {
    return [];
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  const append = (cards: readonly BoardCardDto[] | undefined) => {
    for (const card of cards ?? []) {
      if (!seen.has(card.ticket.id)) {
        seen.add(card.ticket.id);
        ids.push(card.ticket.id);
      }
    }
  };
  if (board.merged !== null) {
    append(board.merged.lanes.ready);
  }
  for (const entry of board.projects) {
    append(entry.board.lanes.ready);
  }
  return ids;
}

/**
 * 選択 (順序を持たない Set) から実行計画を作る。
 *
 * 実行順は effectivePriority → priority → 表示順。1 つのレーンの中ではサーバーが
 * この 2 キーを先頭に並べているので表示順と一致し、分割ビューで複数プロジェクトに
 * またがるときは優先度で混ぜて、同じ優先度どうしは画面の上 (先のセクション) から
 * 実行する。表示順に無い ID (起こらない想定) は同じ優先度の中で最後に回す。
 */
export function buildBulkRunPlan(
  selectedIds: ReadonlySet<string>,
  cardsById: ReadonlyMap<string, BoardCardDto>,
  readyDisplayOrder: readonly string[],
): BulkRunPlan {
  const displayIndex = new Map<string, number>();
  readyDisplayOrder.forEach((id, index) => displayIndex.set(id, index));

  const eligible: BoardCardDto[] = [];
  const counts = new Map<BulkRunExclusionReason, number>();
  for (const id of selectedIds) {
    const card = cardsById.get(id);
    const reason = classifyBulkRunCard(card);
    if (reason !== null) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    } else if (card !== undefined) {
      eligible.push(card);
    }
  }

  const rankOf = (card: BoardCardDto) =>
    displayIndex.get(card.ticket.id) ?? Number.MAX_SAFE_INTEGER;
  const runCards = [...eligible].sort(
    (a, b) =>
      a.effectivePriority - b.effectivePriority ||
      a.ticket.priority - b.ticket.priority ||
      rankOf(a) - rankOf(b),
  );

  const exclusions = BULK_RUN_EXCLUSION_REASONS.flatMap((reason) => {
    const count = counts.get(reason) ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  });

  return {
    runCards,
    runTicketIds: runCards.map((card) => card.ticket.id),
    exclusions,
    excludedCount: exclusions.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/** 「epic 1 件・ブロック中 2 件」の形。対象外が無ければ null。 */
export function describeBulkRunExclusions(
  exclusions: readonly BulkRunExclusion[],
): string | null {
  if (exclusions.length === 0) {
    return null;
  }
  return exclusions
    .map((entry) => `${BULK_RUN_EXCLUSION_LABELS[entry.reason]} ${entry.count} 件`)
    .join('・');
}

/**
 * 実行対象のカードのプロジェクトのうち、ハーネスの前提 (注入・hook 登録・検証
 * コントラクト) を満たしていないものを「プロジェクト名: 理由」で並べる。1 つも
 * 無ければ null。対象外にしたカードは走らないので、そのプロジェクトは見ない。
 *
 * 判定は一括操作バーの「▶ 実行」(useBulkAgentRun) と同じ describeHarnessRunBlock。
 * 状態が未取得 (harnessStatuses が undefined、またはそのプロジェクトが載っていない)
 * なら「不明」であって「不備」ではないので止めない — 最終判定はサーバーの 409。
 */
export function describeBulkRunHarnessBlock(
  runCards: readonly BoardCardDto[],
  harnessStatuses: ReadonlyMap<string, ProjectHarnessStatusDto> | undefined,
  projectNames: ReadonlyMap<string, string>,
): string | null {
  if (harnessStatuses === undefined) {
    return null;
  }
  const reasons: string[] = [];
  const seenProjects = new Set<string>();
  for (const card of runCards) {
    if (seenProjects.has(card.projectId)) {
      continue;
    }
    seenProjects.add(card.projectId);
    const reason = describeHarnessRunBlock(harnessStatuses.get(card.projectId));
    if (reason !== null) {
      const name = projectNames.get(card.projectId) ?? projectNameFallback(card.projectId);
      reasons.push(`${name}: ${reason}`);
    }
  }
  return reasons.length === 0 ? null : reasons.join(' / ');
}
