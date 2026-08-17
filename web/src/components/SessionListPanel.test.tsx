import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentProcessDto,
  ProjectDto,
  SessionDto,
  SessionHistoryEntryDto,
} from '../api';
import { SessionListPanel } from './SessionListPanel';

vi.mock('../api', () => ({
  fetchProjects: vi.fn(),
  fetchSessions: vi.fn(),
  fetchSessionHistory: vi.fn(),
  fetchAgentProcesses: vi.fn(),
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import {
  ApiError,
  fetchAgentProcesses,
  fetchProjects,
  fetchSessionHistory,
  fetchSessions,
} from '../api';

const fetchProjectsMock = vi.mocked(fetchProjects);
const fetchSessionsMock = vi.mocked(fetchSessions);
const fetchSessionHistoryMock = vi.mocked(fetchSessionHistory);
const fetchAgentProcessesMock = vi.mocked(fetchAgentProcesses);

function makeSessionDto(
  overrides: Partial<SessionDto> & Pick<SessionDto, 'sessionId'>,
): SessionDto {
  return {
    pid: 12345,
    cwd: '/projects/a',
    alive: true,
    startedAt: '2026-06-01T10:00:00.000Z',
    lastActivityAt: '2026-06-01T12:00:00.000Z',
    liveness: 'active',
    ...overrides,
  };
}

function makeProjectDto(
  overrides: Partial<ProjectDto> & Pick<ProjectDto, 'id'>,
): ProjectDto {
  return {
    name: overrides.name ?? overrides.id,
    rootPath: '/projects/a',
    prefixes: ['bdboard'],
    sessionCount: 0,
    activeSessionCount: 0,
    sessions: [],
    ...overrides,
  };
}

function makeHistoryEntry(
  overrides: Partial<SessionHistoryEntryDto> & {
    session: SessionHistoryEntryDto['session'];
  },
): SessionHistoryEntryDto {
  return {
    tickets: [],
    ...overrides,
  };
}

function makeAgentProcessDto(
  overrides: Partial<AgentProcessDto> & Pick<AgentProcessDto, 'pid' | 'command' | 'cwd'>,
): AgentProcessDto {
  return {
    ...overrides,
  };
}

function renderSessionListPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SessionListPanel onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('SessionListPanel', () => {
  beforeEach(() => {
    fetchProjectsMock.mockReset();
    fetchSessionsMock.mockReset();
    fetchSessionHistoryMock.mockReset();
    fetchAgentProcessesMock.mockReset();

    fetchProjectsMock.mockResolvedValue([
      makeProjectDto({
        id: 'proj-a',
        name: 'Project Alpha',
        sessions: [
          makeSessionDto({ sessionId: 'session-live', name: 'Live session' }),
        ],
        sessionCount: 1,
        activeSessionCount: 1,
      }),
    ]);
    fetchSessionsMock.mockResolvedValue([
      makeSessionDto({ sessionId: 'session-live', name: 'Live session' }),
    ]);
    fetchSessionHistoryMock.mockResolvedValue([]);
    fetchAgentProcessesMock.mockResolvedValue([]);
  });

  it('shows active sessions by default on the active tab', async () => {
    renderSessionListPanel();

    expect(await screen.findByText('Live session')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '稼働中' }),
    ).toBeInTheDocument();
    expect(fetchSessionHistoryMock).not.toHaveBeenCalled();
  });

  it('shows ended session history when the ended tab is selected', async () => {
    const user = userEvent.setup();
    fetchSessionHistoryMock.mockResolvedValue([
      makeHistoryEntry({
        session: makeSessionDto({
          sessionId: 'session-ended',
          name: 'Ended session',
          alive: false,
          liveness: 'dormant',
          lastActivityAt: '2026-06-01T11:30:00.000Z',
        }),
        projectId: 'proj-a',
        projectName: 'Project Alpha',
        tickets: [
          { ticketId: 'bdboard-done', title: 'Finished ticket' },
          { ticketId: 'bdboard-only-id' },
        ],
      }),
    ]);

    renderSessionListPanel();
    await screen.findByText('Live session');

    await user.click(screen.getByRole('button', { name: '終了' }));

    expect(await screen.findByText('Ended session')).toBeInTheDocument();
    expect(screen.getByText('Project Alpha')).toBeInTheDocument();
    expect(screen.getByText('bdboard-done — Finished ticket')).toBeInTheDocument();
    expect(screen.getByText('bdboard-only-id')).toBeInTheDocument();
    expect(fetchSessionHistoryMock).toHaveBeenCalledTimes(1);
  });

  it('shows empty state when there are no ended sessions', async () => {
    const user = userEvent.setup();
    fetchSessionHistoryMock.mockResolvedValue([]);

    renderSessionListPanel();
    await screen.findByText('Live session');

    await user.click(screen.getByRole('button', { name: '終了' }));

    expect(
      await screen.findByText('終了したセッションはありません'),
    ).toBeInTheDocument();
  });

  it('shows detected agent processes when the processes tab is selected', async () => {
    const user = userEvent.setup();
    fetchAgentProcessesMock.mockResolvedValue([
      makeAgentProcessDto({
        pid: 4242,
        command: 'claude',
        cwd: '/projects/a',
        projectId: 'proj-a',
        projectName: 'Project Alpha',
      }),
    ]);

    renderSessionListPanel();
    await screen.findByText('Live session');

    await user.click(screen.getByRole('button', { name: 'プロセス' }));

    expect(
      await screen.findByText(
        '起動中のエージェントプロセスを検知しています。最終活動時刻は分からないため、稼働/停滞の判定はできません。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('4242')).toBeInTheDocument();
    expect(screen.getByText('Project Alpha')).toBeInTheDocument();
    expect(document.querySelector('.liveness-dot')).toBeNull();
    expect(fetchAgentProcessesMock).toHaveBeenCalledTimes(1);
    expect(fetchSessionHistoryMock).not.toHaveBeenCalled();
  });

  it('shows unavailable message when process detection returns 501', async () => {
    const user = userEvent.setup();
    fetchAgentProcessesMock.mockRejectedValue(
      new ApiError(501, 'process scanner not available'),
    );

    renderSessionListPanel();
    await screen.findByText('Live session');

    await user.click(screen.getByRole('button', { name: 'プロセス' }));

    expect(
      await screen.findByText('この環境ではプロセス検知に対応していません'),
    ).toBeInTheDocument();
  });

  it('shows empty state when no agent processes are detected', async () => {
    const user = userEvent.setup();
    fetchAgentProcessesMock.mockResolvedValue([]);

    renderSessionListPanel();
    await screen.findByText('Live session');

    await user.click(screen.getByRole('button', { name: 'プロセス' }));

    expect(
      await screen.findByText('検知されたエージェントプロセスはありません'),
    ).toBeInTheDocument();
  });
});
