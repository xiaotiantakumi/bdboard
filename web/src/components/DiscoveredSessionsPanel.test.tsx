import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, adoptDiscoveredChatSession, fetchDiscoveredChatSessions } from '../api';
import { DiscoveredSessionsPanel } from './DiscoveredSessionsPanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchDiscoveredChatSessions: vi.fn(),
    adoptDiscoveredChatSession: vi.fn(),
  };
});

const fetchSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const adoptSessionMock = vi.mocked(adoptDiscoveredChatSession);

describe('DiscoveredSessionsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading and then the discovered sessions', async () => {
    let resolve!: (value: { sessions: Array<Record<string, unknown>> }) => void;
    const pending = new Promise<{ sessions: Array<Record<string, unknown>> }>((res) => {
      resolve = res;
    });
    fetchSessionsMock.mockReturnValue(pending as never);
    render(<DiscoveredSessionsPanel projectId="proj-a" onResume={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText('CLIセッションを検索中…')).toBeInTheDocument();
    resolve({
      sessions: [{
        sessionId: '12345678-abcdefgh',
        lastActivityAt: '2026-08-16T12:00:00.000Z',
        alreadyAdopted: true,
        lastMessagePreview: '直近のメッセージ',
      }],
    });

    expect(await screen.findByText('12345678')).toBeInTheDocument();
    expect(screen.getByText('登録済み')).toBeInTheDocument();
    expect(screen.getByText('直近のメッセージ')).toBeInTheDocument();
  });

  it('shows the claude-only scope note unconditionally, before the fetch resolves (bdboard-81b)', () => {
    // 注記は discovery のフェッチ結果に依存しない固定表示であることを固定するため、
    // 意図的に fetch を pending のまま(resolve しない)にして同期 getByText で確認する。
    fetchSessionsMock.mockReturnValue(new Promise(() => {}) as never);
    render(<DiscoveredSessionsPanel projectId="proj-a" onResume={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/対象は claude CLI セッションのみです/)).toBeInTheDocument();
    expect(screen.getByText(/cursor-agent 等の他エージェントのチャットはここには出ません/)).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    fetchSessionsMock.mockResolvedValue({ sessions: [] });
    render(<DiscoveredSessionsPanel projectId="proj-a" onResume={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('再開できるCLIセッションはありません。')).toBeInTheDocument();
  });

  it('adopts a session and closes the panel', async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [{ sessionId: 'session-1', lastActivityAt: '2026-08-16T12:00:00Z', alreadyAdopted: false }],
    });
    adoptSessionMock.mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'claude',
      seedMessages: [{ role: 'user', text: 'hi', timestamp: '2026-08-16T12:00:00.000Z' }],
    });
    const onResume = vi.fn();
    const onClose = vi.fn();
    render(<DiscoveredSessionsPanel projectId="proj-a" onResume={onResume} onClose={onClose} />);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'セッション session-1 を再開' }));
    await waitFor(() => expect(adoptSessionMock).toHaveBeenCalledWith('proj-a', 'session-1'));
    expect(onResume).toHaveBeenCalledWith('session-1', 'claude', [
      { role: 'user', text: 'hi', timestamp: '2026-08-16T12:00:00.000Z' },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an adoption error without resuming', async () => {
    fetchSessionsMock.mockResolvedValue({
      sessions: [{ sessionId: 'session-1', lastActivityAt: '2026-08-16T12:00:00Z', alreadyAdopted: false }],
    });
    adoptSessionMock.mockRejectedValue(new ApiError(404, 'unknown chat session', { errorMessage: 'unknown chat session' }));
    const onResume = vi.fn();
    render(<DiscoveredSessionsPanel projectId="proj-a" onResume={onResume} onClose={vi.fn()} />);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'セッション session-1 を再開' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unknown chat session');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('shows a fetch error', async () => {
    fetchSessionsMock.mockRejectedValue(new ApiError(404, 'project not found', { errorMessage: 'project not found' }));
    render(<DiscoveredSessionsPanel projectId="missing" onResume={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('project not found');
  });
});
