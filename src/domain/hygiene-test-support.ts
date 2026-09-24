// bdboard-sso1.82: hygiene.test.ts (1835 行) の move-only 分割で、検査種別 (kind) 別の
// テストファイル群から共有されるフィクスチャ/ヘルパーの置き場。中身は元 hygiene.test.ts
// 冒頭にあった NOW / issueKinds / issuesFor / blocksEdge / localDate をそのまま移しただけで、
// 実装・値は一切変えていない。複数ファイルから import されるため export を付けている
// (単一ファイルからしか使わないヘルパーは各テストファイル側に残している)。
import { checkHygiene } from './hygiene.js';
import type { DependencyEdge } from './dependency.js';
import type { Ticket } from './ticket.js';

export const NOW = new Date('2026-06-01T12:00:00.000Z');

export function issueKinds(tickets: readonly Ticket[]) {
  return checkHygiene(tickets, { now: NOW }).map((issue) => issue.kind);
}

export function issuesFor(ticketId: string, tickets: readonly Ticket[]) {
  return checkHygiene(tickets, { now: NOW }).filter(
    (issue) => issue.ticketId === ticketId,
  );
}

export function blocksEdge(issueId: string, dependsOnId: string): DependencyEdge {
  return { issueId, dependsOnId, kind: 'blocks' };
}

export function localDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
): Date {
  return new Date(year, month - 1, day, hour);
}
