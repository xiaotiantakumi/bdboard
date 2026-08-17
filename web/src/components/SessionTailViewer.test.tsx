import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeHistory } from '../test/fakeHistory';
import { SessionTailViewer } from './SessionTailViewer';

vi.mock('../api', () => ({
  fetchSessionTail: vi.fn(),
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

import { ApiError, fetchSessionTail } from '../api';

const fetchSessionTailMock = vi.mocked(fetchSessionTail);

function renderViewer() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const onClose = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <SessionTailViewer
        sessionId="session-1"
        sessionLabel="Test session"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );

  return { onClose };
}

describe('SessionTailViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFakeHistory();
  });

  it('shows transcript messages when fetch succeeds', async () => {
    fetchSessionTailMock.mockResolvedValue({
      sessionId: 'session-1',
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi there' },
      ],
    });

    renderViewer();

    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(screen.getByText('hi there')).toBeInTheDocument();
    expect(screen.getByText('ユーザー')).toBeInTheDocument();
    expect(screen.getByText('アシスタント')).toBeInTheDocument();
  });

  it('shows error message when fetch fails', async () => {
    fetchSessionTailMock.mockRejectedValue(new ApiError(404, 'transcript not found'));

    renderViewer();

    expect(await screen.findByText('transcript not found')).toBeInTheDocument();
  });

  it('closes when close button is clicked', async () => {
    fetchSessionTailMock.mockResolvedValue({
      sessionId: 'session-1',
      messages: [],
    });

    const { onClose } = renderViewer();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '閉じる' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
