import { compareStrings } from './compare.js';
import type { LeftoverCandidate } from './git-worktree.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

/**
 * 着手中チケット同士のファイル重複 (npm run drift の「着手中版」)。
 *
 * `npm run drift` は「main と自分のブランチが両方触ったファイル」を PR 直前に出すが、
 * **並列で着手した別チケット同士**の干渉は rebase で衝突するまで誰にも見えない
 * (docs/HARNESS-EVALUATION.md §3.2(b))。ここはその欠けている辺を、worktree から
 * 取った変更ファイル集合の交差として計算する純粋関数。
 */

/** 1 チケット = 1 worktree ぶんの変更ファイル集合 */
export interface InFlightFileEntry {
  readonly ticketId: TicketId;
  readonly projectId: string;
  /** リポジトリルート相対のパス。順序・重複は問わない */
  readonly files: readonly string[];
}

/** 同じファイルを触っているチケット **ペア** */
export interface InFlightOverlap {
  readonly projectId: string;
  /** 昇順に整列した 2 件。ペアは無向なので [a, b] と [b, a] は同一 */
  readonly ticketIds: readonly [TicketId, TicketId];
  /** 昇順に整列した交差ファイル。必ず 1 件以上 */
  readonly files: readonly string[];
}

/** 詳細パネル向けに「相手 1 件ぶん」へ畳んだ形 */
export interface InFlightOverlapPeer {
  readonly ticketId: TicketId;
  readonly files: readonly string[];
}

/** メッセージに列挙するファイル数の上限 */
export const OVERLAP_MESSAGE_FILE_LIMIT = 5;

function entryKey(projectId: string, ticketId: TicketId): string {
  return `${projectId}\0${ticketId}`;
}

/**
 * 同じファイルを触っているチケットのペアを列挙する。
 *
 * - 比較は **同一プロジェクト内でのみ** 行う。bd のチケット ID はプロジェクト内でしか
 *   一意でなく、別プロジェクトのリポジトリ相対パスが偶然一致しても意味が無い。
 * - 同じ (projectId, ticketId) が複数回来たらファイルを和集合にまとめる。呼び出し側が
 *   1 チケットに複数 worktree を見つけたときに、自分自身とのペアを作らないため。
 * - 交差が空のペアは返さない。
 */
export function computeInFlightOverlaps(
  entries: readonly InFlightFileEntry[],
): readonly InFlightOverlap[] {
  const merged = new Map<
    string,
    { projectId: string; ticketId: TicketId; files: Set<string> }
  >();

  for (const entry of entries) {
    const key = entryKey(entry.projectId, entry.ticketId);
    let slot = merged.get(key);
    if (slot === undefined) {
      slot = { projectId: entry.projectId, ticketId: entry.ticketId, files: new Set() };
      merged.set(key, slot);
    }
    for (const file of entry.files) {
      if (file.length > 0) {
        slot.files.add(file);
      }
    }
  }

  const byProject = new Map<
    string,
    Array<{ ticketId: TicketId; files: Set<string> }>
  >();
  for (const slot of merged.values()) {
    if (slot.files.size === 0) {
      continue;
    }
    let bucket = byProject.get(slot.projectId);
    if (bucket === undefined) {
      bucket = [];
      byProject.set(slot.projectId, bucket);
    }
    bucket.push({ ticketId: slot.ticketId, files: slot.files });
  }

  const overlaps: InFlightOverlap[] = [];

  for (const [projectId, bucket] of byProject) {
    const sorted = [...bucket].sort((a, b) => compareStrings(a.ticketId, b.ticketId));

    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const left = sorted[i]!;
        const right = sorted[j]!;

        // 小さいほうを走査する。片方が巨大な worktree でももう片方の件数で抑えられる。
        const [probe, against] =
          left.files.size <= right.files.size
            ? [left.files, right.files]
            : [right.files, left.files];

        const shared: string[] = [];
        for (const file of probe) {
          if (against.has(file)) {
            shared.push(file);
          }
        }
        if (shared.length === 0) {
          continue;
        }

        overlaps.push({
          projectId,
          ticketIds: [left.ticketId, right.ticketId],
          files: shared.sort(compareStrings),
        });
      }
    }
  }

  return overlaps.sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    if (projectDiff !== 0) {
      return projectDiff;
    }
    const firstDiff = compareStrings(a.ticketIds[0], b.ticketIds[0]);
    if (firstDiff !== 0) {
      return firstDiff;
    }
    return compareStrings(a.ticketIds[1], b.ticketIds[1]);
  });
}

/** 1 チケットから見た「衝突しうる相手」の一覧。詳細パネル用 */
export function overlapPeersForTicket(
  overlaps: readonly InFlightOverlap[],
  projectId: string,
  ticketId: TicketId,
): readonly InFlightOverlapPeer[] {
  const peers: InFlightOverlapPeer[] = [];

  for (const overlap of overlaps) {
    if (overlap.projectId !== projectId) {
      continue;
    }
    const [a, b] = overlap.ticketIds;
    if (a === ticketId) {
      peers.push({ ticketId: b, files: overlap.files });
    } else if (b === ticketId) {
      peers.push({ ticketId: a, files: overlap.files });
    }
  }

  return peers.sort((x, y) => compareStrings(x.ticketId, y.ticketId));
}

/** `a.ts, b.ts (+3)` — 先頭 OVERLAP_MESSAGE_FILE_LIMIT 件だけ並べ、残りは件数で示す */
export function formatOverlapFiles(
  files: readonly string[],
  limit = OVERLAP_MESSAGE_FILE_LIMIT,
): string {
  const shown = files.slice(0, limit);
  const rest = files.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} (+${rest})` : shown.join(', ');
}

/** 変更ファイルを取りに行くべき worktree。「closed でない × worktree がある」 */
export interface InFlightWorktree {
  readonly projectId: string;
  readonly ticketId: TicketId;
  readonly worktreePath: string;
}

/**
 * leftover 候補 (merged_leftover と同じ worktree 一覧) から、着手中ぶんだけ選ぶ。
 *
 * merged_leftover が「closed なのに worktree が残っている」を見るのに対して、こちらは
 * その補集合 = 「まだ closed でないチケットの worktree」を見る。両者で同じ
 * collectLeftoverCandidates の結果を使い回すので、git worktree list は 1 回で済む。
 *
 * deferred や blocked も含める。ステータスが何であれ worktree にファイルが積まれて
 * いる以上、後から rebase で衝突する事実は変わらない。
 */
export function selectInFlightWorktrees(
  candidates: readonly LeftoverCandidate[],
  tickets: readonly Ticket[],
): readonly InFlightWorktree[] {
  const ticketByKey = new Map<string, Ticket>(
    tickets.map((ticket) => [entryKey(ticket.projectId, ticket.id), ticket] as const),
  );

  const selected: InFlightWorktree[] = [];

  for (const candidate of candidates) {
    if (candidate.worktreePath === null) {
      continue;
    }
    const ticket = ticketByKey.get(entryKey(candidate.projectId, candidate.ticketId));
    if (ticket === undefined) {
      continue;
    }
    if (ticket.status === 'closed') {
      continue;
    }

    selected.push({
      projectId: candidate.projectId,
      ticketId: candidate.ticketId,
      worktreePath: candidate.worktreePath,
    });
  }

  return selected.sort((a, b) => {
    const projectDiff = compareStrings(a.projectId, b.projectId);
    return projectDiff !== 0 ? projectDiff : compareStrings(a.ticketId, b.ticketId);
  });
}
