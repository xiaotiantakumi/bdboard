import type { SessionDto } from './sessions';
import type { TicketSummaryDto } from './tickets-read';
import { fetchJson } from './http';

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

export interface StatusDto {
  lastRefreshAt: string | null;
  errors: { kind: string; projectId: string; detail: string }[];
  projectCount: number;
  /** Set only when BDBOARD_TIMEZONE overrides the host timezone. */
  boardTimeZone: string | null;
}

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
  deferUrgency: 'overdue' | 'today' | 'soon' | 'later' | null;
  effectivePriority: number;
  priorityInheritedFrom: string | null;
}

export interface BoardDto {
  lanes: Record<string, BoardCardDto[]>;
  cardCount: number;
  /**
   * done(closed) レーンの切り捨て前の総件数。サーバー側の closedLimit(既定100件/
   * プロジェクト)を超えると lanes.done.length より大きくなる — その差分が
   * 「他 N 件 (非表示)」の件数(bdboard-3tw.86)。
   */
  closedTotal: number;
  /**
   * closedLimit で切り捨てられ、lanes.done には出てこないチケットのID一覧
   * (カード全体ではなくIDのみ)。既知ID自動リンク判定(App.tsx の boardTicketIds →
   * isTicketOnBoard)がこれも「ボード上に存在する」として拾うために使う
   * (bdboard-3tw.86 回帰対応)。
   */
  truncatedClosedIds: string[];
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

export type BoardMode = 'merged' | 'split';

// 列の表示順は「着手可能 → 進行中 → 確認待ち → ブロック → 完了」(bdboard-662)。この配列の
// 並びがそのままレーン列の表示順になる(BoardView.tsx の visibleLanes 参照)。サーバー側の
// LANES (src/domain/readiness.ts)と値の集合を必ず一致させること(web は src を import
// できないため、独立に2箇所で定義している)。
//
// bdboard-662: 「保留(deferred)」は独立レーンを持たず「ブロック(blocked)」に表示統合される。
// bd 上の status は 'deferred' のまま変更しない(defer_until の情報や bd ready の除外挙動を
// 壊さないため)。カードの deferDays/deferUrgency 表示は lane==='blocked' の条件で維持する
// (LaneColumn.tsx の showDeferCountdown 参照)。
export const LANES = ['ready', 'in_progress', 'awaiting_human', 'blocked', 'done'] as const;
export type Lane = (typeof LANES)[number];

export const LANE_LABELS: Record<Lane, string> = {
  ready: '着手可能',
  in_progress: '進行中',
  awaiting_human: '確認待ち',
  blocked: 'ブロック',
  done: '完了',
};

// bd 組み込みの hooked は「エージェントの hook に紐づく＝作業中」、pinned は「先頭固定の未完了＝open 相当」
// なのでサーバ側の deriveLane はそれぞれ in_progress / ready へ載せる。ここに含めないと正常な
// チケットに食い違いバッジが出てしまう。
// awaiting_human は bd の human ラベルという status とは独立の軸で決まる派生レーンなので、
// どの status が来ても「食い違い」ではない。あえてキーを設けず、isLaneStatusMismatch 側で
// 未定義=判定スキップとして扱う(常にバッジ非表示)。
// blocked は bdboard-662 で保留(deferred)を吸収したため、bd status 'blocked' に加えて
// 'deferred' も期待値に含める(そうしないと保留チケット全件に食い違いバッジが出てしまう)。
// 依存関係由来で自動的にブロック扱いになったチケット(status は 'open' のまま)は従来どおり
// 食い違いとして扱う(意図的な既存挙動)。
export const LANE_EXPECTED_STATUS: Partial<Record<Lane, readonly string[]>> = {
  in_progress: ['in_progress', 'hooked'],
  blocked: ['blocked', 'deferred'],
  ready: ['open', 'ready', 'pinned'],
  done: ['closed', 'done'],
};

/** サーバーの実行プラットフォームで使えない機能 (bdboard-70z.9)。 */
export type PlatformFeature = 'session-discovery' | 'chat';

export interface PlatformLimitationDto {
  feature: PlatformFeature;
  /** UI にそのまま出す一文。 */
  reason: string;
  /** 「なぜ直せないのか」の技術的な根拠。 */
  detail: string;
}

export interface PlatformSupportDto {
  platform: string;
  limitations: PlatformLimitationDto[];
}

export function fetchPlatformSupport(): Promise<PlatformSupportDto> {
  return fetchJson<PlatformSupportDto>('/api/platform-support');
}

export function fetchBoard(params: {
  projectIds: string[];
  view: BoardMode;
  epicId?: string;
}): Promise<BoardViewDto> {
  const searchParams = new URLSearchParams();
  searchParams.set('view', params.view);
  if (params.projectIds.length > 0) {
    searchParams.set('projects', params.projectIds.join(','));
  }
  if (params.epicId !== undefined) {
    searchParams.set('epicId', params.epicId);
  }
  return fetchJson<BoardViewDto>(`/api/board?${searchParams.toString()}`);
}

export function fetchStatus(): Promise<StatusDto> {
  return fetchJson<StatusDto>('/api/status');
}

export function postRefresh(): Promise<void> {
  return fetchJson<{ ok: boolean }>('/api/refresh', { method: 'POST' }).then(() => undefined);
}

export function fetchProjects(): Promise<ProjectDto[]> {
  return fetchJson<ProjectDto[]>('/api/projects');
}

export interface PrBadgeDto {
  ticketId: string;
  projectId: string;
  url: string;
  state: string | null;
  checkStatus: string | null;
}

export function fetchPrLinks(
  projectIds: readonly string[] = [],
): Promise<PrBadgeDto[]> {
  const searchParams = new URLSearchParams();
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  const query = searchParams.toString();
  const path = query.length > 0 ? `/api/pr-links?${query}` : '/api/pr-links';
  return fetchJson<PrBadgeDto[]>(path);
}

export interface GraphNodeDto {
  ticketId: string;
  projectId: string;
  title: string;
  status: string;
  priority: number;
  issueType: string;
  layer: number;
}

export interface GraphEdgeDto {
  from: string;
  to: string;
  kind: 'blocks' | 'parent-child';
}

export interface DependencyGraphDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export function fetchDependencyGraph(
  projectIds: readonly string[] = [],
): Promise<DependencyGraphDto> {
  const searchParams = new URLSearchParams();
  if (projectIds.length > 0) {
    searchParams.set('projects', projectIds.join(','));
  }
  const query = searchParams.toString();
  const path = query.length > 0 ? `/api/graph?${query}` : '/api/graph';
  return fetchJson<DependencyGraphDto>(path);
}

export function isLaneStatusMismatch(lane: string, status: string): boolean {
  const expected = LANE_EXPECTED_STATUS[lane as Lane];
  if (expected === undefined) {
    return false;
  }
  return !expected.includes(status);
}

export function projectNameFallback(projectId: string): string {
  const parts = projectId.split(/[/\\]/);
  return parts[parts.length - 1] || projectId;
}
