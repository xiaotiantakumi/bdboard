import type {
  ActivityEventDto,
  BoardCardDto,
  BoardDto,
  PendingDecisionDto,
} from '../api';
import { LANES, projectNameFallback } from '../api';
import type { ActivityWindowDays } from '../uiPersistedState';
import { activityWindowLabel } from '../uiPersistedState';
import { formatActivityTime, localDateKey } from './activityFeedFormatting';

export interface DailyDigestInput {
  readonly now: Date;
  readonly windowDays: ActivityWindowDays;
  /** /api/activity の生データ。closed 以外も含んでよい（中で絞る）。 */
  readonly activityEvents: readonly ActivityEventDto[];
  /** /api/board?view=merged の merged ボード。null 可。 */
  readonly board: BoardDto | null;
  readonly pendingDecisions: readonly PendingDecisionDto[];
  /** projectId -> 表示名 */
  readonly projectNames: ReadonlyMap<string, string>;
  /**
   * 画面のプロジェクトフィルタ。空配列は「全プロジェクト」。
   * board と activityEvents はサーバ側で既に絞られているので、ここではフィルタが
   * 効いていない pendingDecisions にだけ適用する。
   */
  readonly selectedProjectIds: readonly string[];
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function optionalTitleSuffix(title: string): string {
  const normalized = normalizeText(title);
  return normalized.length > 0 ? ` ${normalized}` : '';
}

function projectDisplayName(
  projectId: string,
  projectNames: ReadonlyMap<string, string>,
): string {
  return projectNames.get(projectId) ?? projectNameFallback(projectId);
}

function findTicketTitle(board: BoardDto | null, ticketId: string): string | undefined {
  if (board === null) {
    return undefined;
  }
  for (const lane of LANES) {
    const cards = board.lanes[lane] ?? [];
    const found = cards.find((card) => card.ticket.id === ticketId);
    if (found !== undefined) {
      return found.ticket.title;
    }
  }
  return undefined;
}

function sortClosedEvents(events: readonly ActivityEventDto[]): ActivityEventDto[] {
  return [...events].sort((left, right) => {
    const atCompare = new Date(right.at).getTime() - new Date(left.at).getTime();
    if (atCompare !== 0) {
      return atCompare;
    }
    return left.id.localeCompare(right.id);
  });
}

function filterPendingDecisions(
  pendingDecisions: readonly PendingDecisionDto[],
  selectedProjectIds: readonly string[],
): PendingDecisionDto[] {
  const filtered =
    selectedProjectIds.length > 0
      ? pendingDecisions.filter((decision) => selectedProjectIds.includes(decision.projectId))
      : [...pendingDecisions];
  return filtered.sort((left, right) => left.id.localeCompare(right.id));
}

function formatCompletedLine(
  event: ActivityEventDto,
  projectNames: ReadonlyMap<string, string>,
): string {
  const project = projectDisplayName(event.projectId, projectNames);
  const base = `- [${project}] ${event.id}${optionalTitleSuffix(event.title)} (P${event.priority})`;
  if (event.reason === undefined) {
    return base;
  }
  const normalizedReason = normalizeText(event.reason);
  return normalizedReason.length > 0 ? `${base} — ${normalizedReason}` : base;
}

function sortActivityEvents(events: readonly ActivityEventDto[]): ActivityEventDto[] {
  return [...events].sort((left, right) => {
    const atCompare = new Date(right.at).getTime() - new Date(left.at).getTime();
    if (atCompare !== 0) {
      return atCompare;
    }
    return left.id.localeCompare(right.id);
  });
}

function formatPriorityChangedLine(
  event: ActivityEventDto,
  projectNames: ReadonlyMap<string, string>,
): string {
  const project = projectDisplayName(event.projectId, projectNames);
  const changeSuffix =
    event.from !== undefined && event.to !== undefined
      ? ` — ${event.from} → ${event.to}`
      : '';
  return `- [${project}] ${event.id}${optionalTitleSuffix(event.title)} (P${event.priority})${changeSuffix}`;
}

function formatInProgressLine(
  card: BoardCardDto,
  projectNames: ReadonlyMap<string, string>,
): string {
  const project = projectDisplayName(card.projectId, projectNames);
  const sessionCount = card.sessions.length;
  const activeCount = card.sessions.filter((session) => session.liveness === 'active').length;
  const suffix =
    sessionCount === 0
      ? '— セッションなし'
      : `— セッション ${sessionCount}件 (稼働中 ${activeCount}件)`;
  return `- [${project}] ${card.ticket.id}${optionalTitleSuffix(card.ticket.title)} (P${card.ticket.priority}) ${suffix}`;
}

function formatBlockedLine(
  card: BoardCardDto,
  projectNames: ReadonlyMap<string, string>,
): string {
  const project = projectDisplayName(card.projectId, projectNames);
  const waitSuffix =
    card.blockedBy.length === 0
      ? '— 待ち: なし'
      : `— 待ち: ${card.blockedBy.join(', ')}`;
  return `- [${project}] ${card.ticket.id}${optionalTitleSuffix(card.ticket.title)} (P${card.ticket.priority}) ${waitSuffix}`;
}

function formatPendingDecisionLine(
  decision: PendingDecisionDto,
  board: BoardDto | null,
  projectNames: ReadonlyMap<string, string>,
): string {
  const project = projectDisplayName(decision.projectId, projectNames);
  const rawTitle = findTicketTitle(board, decision.id);
  const normalizedTitle = rawTitle !== undefined ? normalizeText(rawTitle) : '';
  const titlePart = normalizedTitle.length > 0 ? ` ${normalizedTitle}` : '';
  const normalizedQuestion =
    decision.question !== undefined ? normalizeText(decision.question) : '';
  const questionPart =
    normalizedQuestion.length > 0 ? normalizedQuestion : '(質問文なし)';
  return `- [${project}] ${decision.id}${titlePart} — ${questionPart}`;
}

function formatSection(heading: string, lines: readonly string[]): string {
  const body = lines.length === 0 ? '- なし' : lines.join('\n');
  return `## ${heading} (${lines.length}件)\n${body}`;
}

export function buildDailyDigestMarkdown(input: DailyDigestInput): string {
  const {
    now,
    windowDays,
    activityEvents,
    board,
    pendingDecisions,
    projectNames,
    selectedProjectIds,
  } = input;

  const closedEvents = activityEvents.filter((event) => event.kind === 'closed');
  const completedLines = sortClosedEvents(closedEvents).map((event) =>
    formatCompletedLine(event, projectNames),
  );

  const priorityChangedEvents = activityEvents.filter(
    (event) => event.kind === 'priority_changed',
  );
  const priorityChangedLines = sortActivityEvents(priorityChangedEvents).map((event) =>
    formatPriorityChangedLine(event, projectNames),
  );

  const inProgressCards = board?.lanes.in_progress ?? [];
  const inProgressLines = inProgressCards.map((card) =>
    formatInProgressLine(card, projectNames),
  );

  const blockedCards = board?.lanes.blocked ?? [];
  const blockedLines = blockedCards.map((card) => formatBlockedLine(card, projectNames));

  const filteredPending = filterPendingDecisions(pendingDecisions, selectedProjectIds);
  const pendingLines = filteredPending.map((decision) =>
    formatPendingDecisionLine(decision, board, projectNames),
  );

  const header = `# デイリーダイジェスト ${localDateKey(now)} ${formatActivityTime(now)} (直近${activityWindowLabel(windowDays)})`;

  return [
    header,
    formatSection('完了', completedLines),
    formatSection('優先度変更', priorityChangedLines),
    formatSection('進行中', inProgressLines),
    formatSection('ブロック中', blockedLines),
    formatSection('決定待ち', pendingLines),
  ].join('\n\n');
}
