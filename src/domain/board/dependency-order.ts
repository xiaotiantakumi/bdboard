import type { BoardCard } from './types.js';
import { computeStronglyConnectedComponents } from '../graph-scc.js';
import type { TicketId } from '../ticket-id.js';

/**
 * bdboard-0rqc: compareCards で並べた順を保ったまま、同じレーンの中で「まだ終わっていない
 * カードに止められているカード」を止めている側より必ず下に置く。確認待ちでは
 * `review_after` による表示順も加える (安定なトポロジカル順)。
 * 依存の無いカード同士の相対順は compareCards のまま。循環している依存はひとまとまりにして、その中は元の順で並べる。
 */
export function orderByLaneDependencies(sorted: readonly BoardCard[]): BoardCard[] {
  const count = sorted.length;
  const positionByKey = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const card = sorted[index];
    positionByKey.set(cardKey(card.projectId, card.ticket.id), index);
  }

  const outgoing: number[][] = Array.from({ length: count }, () => []);
  const seenEdges = new Set<string>();
  let edgeCount = 0;
  const addEdge = (from: number, to: number): void => {
    if (from === to) return;
    const edgeKey = `${from}:${to}`;
    if (seenEdges.has(edgeKey)) return;
    seenEdges.add(edgeKey);
    outgoing[from].push(to);
    edgeCount += 1;
  };

  for (let index = 0; index < count; index += 1) {
    const card = sorted[index];
    for (const blockerId of card.blockedBy) {
      const blockerIndex = positionByKey.get(cardKey(card.projectId, blockerId));
      if (blockerIndex === undefined || blockerIndex === index) continue;
      if (sorted[blockerIndex].lane !== card.lane) continue;
      addEdge(blockerIndex, index);
    }
  }

  // blocks の「止めている側が必ず上」を review_after で崩さない。
  const canReach = (start: number, target: number): boolean => {
    const visited = new Set<number>([start]);
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      if (current === target) return true;
      for (const next of outgoing[current]) {
        if (visited.has(next)) continue;
        visited.add(next);
        pending.push(next);
      }
    }
    return false;
  };

  for (let index = 0; index < count; index += 1) {
    const card = sorted[index];
    if (card.lane === 'awaiting_human') {
      for (const predecessorId of card.ticket.reviewAfter ?? []) {
        const predecessorIndex = positionByKey.get(cardKey(card.projectId, predecessorId));
        if (predecessorIndex === undefined || sorted[predecessorIndex].lane !== card.lane) continue;
        if (!canReach(index, predecessorIndex)) addEdge(predecessorIndex, index);
        for (const gateId of card.blockedBy) {
          const gateIndex = positionByKey.get(cardKey(card.projectId, gateId));
          if (gateIndex === undefined || sorted[gateIndex].lane !== card.lane || gateId === predecessorId) continue;
          if (!canReach(gateIndex, predecessorIndex)) addEdge(predecessorIndex, gateIndex);
        }
      }
    }
  }

  if (edgeCount === 0) return [...sorted];

  // 循環 (bd dep add --no-cycle-check で作れる) は強連結成分ごとに 1 つのまとまりとして扱い、
  // まとまりの中は元の順、まとまり同士は「先頭カードの元の位置」が小さい順に出す。
  // こうすると循環の下流にいるカードが循環より上に来ることも、循環だけが優先度に関係なく
  // レーンの底へ沈むことも無い (bdboard-0rqc の Opus レビュー指摘)。
  const { sccMembers, sccOf } = computeStronglyConnectedComponents(
    sorted.map((_, index) => String(index)),
    (id) => outgoing[Number(id)].map(String),
  );
  const groupCount = sccMembers.length;
  const groupOf = (index: number): number => sccOf.get(String(index)) ?? -1;
  const members: number[][] = sccMembers.map((group) =>
    group.map(Number).sort((left, right) => left - right),
  );
  const groupByLeader = new Map<number, number>();
  members.forEach((group, groupIndex) => groupByLeader.set(group[0], groupIndex));

  const groupOutgoing: number[][] = Array.from({ length: groupCount }, () => []);
  const groupIndegree = Array.from({ length: groupCount }, () => 0);
  const seenGroupEdges = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const from = groupOf(index);
    for (const next of outgoing[index]) {
      const to = groupOf(next);
      if (to === from) continue;
      const key = `${from}:${to}`;
      if (seenGroupEdges.has(key)) continue;
      seenGroupEdges.add(key);
      groupOutgoing[from].push(to);
      groupIndegree[to] += 1;
    }
  }

  const ready = new IndexMinHeap();
  members.forEach((group, groupIndex) => {
    if (groupIndegree[groupIndex] === 0) ready.push(group[0]);
  });

  const ordered: BoardCard[] = [];
  for (let leader = ready.pop(); leader !== undefined; leader = ready.pop()) {
    const groupIndex = groupByLeader.get(leader) ?? -1;
    for (const index of members[groupIndex]) ordered.push(sorted[index]);
    for (const next of groupOutgoing[groupIndex]) {
      groupIndegree[next] -= 1;
      if (groupIndegree[next] === 0) ready.push(members[next][0]);
    }
  }

  return ordered;
}

function cardKey(projectId: string, ticketId: TicketId): string {
  return `${projectId} ${ticketId}`;
}

/** 元インデックスをキーにした二分最小ヒープ (まとまりは先頭カードの元インデックスで積む)。 */
class IndexMinHeap {
  private readonly data: number[] = [];

  push(value: number): void {
    const data = this.data;
    data.push(value);
    let index = data.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (data[parent] <= value) break;
      data[index] = data[parent];
      index = parent;
    }
    data[index] = value;
  }

  pop(): number | undefined {
    const data = this.data;
    if (data.length === 0) return undefined;
    const top = data[0];
    const last = data.pop();
    if (last === undefined || data.length === 0) return top;
    data[0] = last;
    let index = 0;
    let left = 1;
    while (left < data.length) {
      const right = left + 1;
      const smallest = right < data.length && data[right] < data[left] ? right : left;
      if (data[smallest] >= last) break;
      data[index] = data[smallest];
      index = smallest;
      left = index * 2 + 1;
    }
    data[index] = last;
    return top;
  }
}
