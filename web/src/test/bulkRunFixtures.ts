// bdboard-mkm1.2: 「▶ 実行」まわりのテストで共有するカード・盤面・ハーネス状態の組み立て。
import type {
  BoardCardDto,
  BoardDto,
  BoardViewDto,
  ProjectHarnessStatusDto,
} from '../api';

export interface RunCardOptions {
  projectId?: string;
  lane?: string;
  priority?: number;
  effectivePriority?: number;
  issueType?: BoardCardDto['ticket']['issueType'];
  title?: string;
}

export function makeRunCard(id: string, options: RunCardOptions = {}): BoardCardDto {
  const priority = options.priority ?? 2;
  const projectId = options.projectId ?? 'proj-1';
  return {
    ticket: {
      id,
      projectId,
      title: options.title ?? `Ticket ${id}`,
      status: 'open',
      priority,
      issueType: options.issueType ?? 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane: options.lane ?? 'ready',
    projectId,
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: options.effectivePriority ?? priority,
    priorityInheritedFrom: null,
  };
}

/** カードを lane ごとに振り分けた BoardDto。各レーン内の並びは渡した順のまま。 */
export function makeRunBoard(cards: readonly BoardCardDto[]): BoardDto {
  const lanes: Record<string, BoardCardDto[]> = {
    ready: [],
    in_progress: [],
    awaiting_human: [],
    blocked: [],
    done: [],
  };
  for (const card of cards) {
    (lanes[card.lane] ??= []).push(card);
  }
  return { lanes, cardCount: cards.length, closedTotal: 0, truncatedClosedIds: [] };
}

/** 分割ビュー相当 (merged は null、プロジェクトごとの盤面を渡した順に並べる)。 */
export function makeSplitView(
  projects: readonly { id: string; cards: readonly BoardCardDto[] }[],
): BoardViewDto {
  return {
    mode: 'split',
    generatedAt: '2026-01-02T00:00:00.000Z',
    merged: null,
    projects: projects.map(({ id, cards }) => ({
      project: {
        id,
        name: id,
        rootPath: `/tmp/${id}`,
        prefixes: [],
        sessionCount: 0,
        activeSessionCount: 0,
        incompleteTicketCount: 0,
        sessions: [],
      },
      board: makeRunBoard(cards),
    })),
  };
}

export function cardsByIdOf(cards: readonly BoardCardDto[]): Map<string, BoardCardDto> {
  return new Map(cards.map((card) => [card.ticket.id, card]));
}

/** エージェント実行の前提を満たした (installed=true) / 未注入 (false) のハーネス状態。 */
export function makeHarnessStatus(installed = true): ProjectHarnessStatusDto {
  return {
    packs: [
      {
        name: 'bdboard-harness',
        availableVersion: '1.0.0',
        installedVersion: installed ? '1.0.0' : null,
        drift: false,
        hooksState: 'ok',
        missingHooks: [],
      },
    ],
    contract: {
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
      models: null,
      expiredExcludeCount: 0,
      modelExclusionWarnings: [],
    },
  };
}
