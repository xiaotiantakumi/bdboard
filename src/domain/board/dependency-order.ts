import type { BoardCard } from './types.js';
import type { TicketId } from '../ticket-id.js';

/**
 * bdboard-0rqc: compareCards で並べた順を保ったまま、同じレーンの中で「まだ終わっていない
 * カードに止められているカード」を止めている側より必ず下に置く (安定なトポロジカル順)。
 * 依存の無いカード同士の相対順は compareCards のまま。循環している依存は元の順で崩す。
 */
export function orderByLaneDependencies(sorted: readonly BoardCard[]): BoardCard[] {
  const count = sorted.length;
  const positionByKey = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const card = sorted[index];
    positionByKey.set(cardKey(card.projectId, card.ticket.id), index);
  }

  const outgoing: number[][] = Array.from({ length: count }, () => []);
  const indegree = Array.from({ length: count }, () => 0);
  const seenEdges = new Set<string>();
  let edgeCount = 0;

  for (let index = 0; index < count; index += 1) {
    const card = sorted[index];
    for (const blockerId of card.blockedBy) {
      const blockerIndex = positionByKey.get(cardKey(card.projectId, blockerId));
      if (blockerIndex === undefined || blockerIndex === index) continue;
      if (sorted[blockerIndex].lane !== card.lane) continue;
      const edgeKey = `${blockerIndex}:${index}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      outgoing[blockerIndex].push(index);
      indegree[index] += 1;
      edgeCount += 1;
    }
  }

  if (edgeCount === 0) return [...sorted];

  const ready = new IndexMinHeap();
  for (let index = 0; index < count; index += 1) {
    if (indegree[index] === 0) ready.push(index);
  }

  const emitted = Array.from({ length: count }, () => false);
  const ordered: BoardCard[] = [];
  let scan = 0;

  const take = (index: number): void => {
    if (emitted[index]) return;
    emitted[index] = true;
    ordered.push(sorted[index]);
    for (const next of outgoing[index]) {
      indegree[next] -= 1;
      if (indegree[next] === 0 && !emitted[next]) ready.push(next);
    }
  };

  while (ordered.length < count) {
    const next = ready.pop();
    if (next !== undefined) {
      take(next);
      continue;
    }
    while (scan < count && emitted[scan]) scan += 1;
    if (scan >= count) break;
    take(scan);
  }

  return ordered;
}

function cardKey(projectId: string, ticketId: TicketId): string {
  return `${projectId} ${ticketId}`;
}

/** 元インデックスをキーにした二分最小ヒープ。 */
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
