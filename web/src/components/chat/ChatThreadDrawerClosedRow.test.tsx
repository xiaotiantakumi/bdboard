// bdboard-sso1.83 第6段: ChatThreadDrawerClosedRow 抽出時に足した、コンポーネント単体の
// レンダリング/操作テスト。
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { ChatThreadDrawerClosedRow } from './ChatThreadDrawerClosedRow';

describe('ChatThreadDrawerClosedRow', () => {
  it('renders the title and calls reopenClosed(sessionId) on click', async () => {
    const user = userEvent.setup();
    const reopenClosed = vi.fn();
    const thread: ChatThreadDto = {
      sessionId: 'sess-marker-closed',
      agentId: 'claude',
      title: 'closed marker thread',
      pinned: false,
      updatedAt: '2026-01-01T00:00:00Z',
    };
    render(<ChatThreadDrawerClosedRow thread={thread} actions={{ reopenClosed }} />);
    const button = screen.getByRole('button', { name: 'closed marker thread' });
    await user.click(button);
    expect(reopenClosed).toHaveBeenCalledWith('sess-marker-closed');
  });

  it('shows "(無題)" when title is null, and the pin marker only when pinned', () => {
    const thread: ChatThreadDto = {
      sessionId: 'sess-marker-untitled-closed',
      agentId: 'claude',
      title: null,
      pinned: true,
      updatedAt: '2026-01-01T00:00:00Z',
    };
    render(<ChatThreadDrawerClosedRow thread={thread} actions={{ reopenClosed: vi.fn() }} />);
    expect(screen.getByRole('button', { name: '(無題)' })).toBeInTheDocument();
    expect(document.querySelector('.chat-thread-drawer-item-pin')).toBeInTheDocument();
  });
});
