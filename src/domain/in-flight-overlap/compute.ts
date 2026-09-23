import { compareStrings } from '../compare.js';
import type { TicketId } from '../ticket-id.js';
import { entryKey, type InFlightFileEntry, type InFlightOverlap, type InFlightOverlapPeer } from './types.js';

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
