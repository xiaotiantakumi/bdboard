// bdboard-sso1.83 第7段: ChatPanelHeader 抽出時に足した、コンポーネント単体の
// レンダリング/操作テスト。
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatPanelHeader } from './ChatPanelHeader';

describe('ChatPanelHeader', () => {
  it('shows "最大化" when not maximized, calls onToggleMaximize on click, without aria-pressed', async () => {
    const user = userEvent.setup();
    const onToggleMaximize = vi.fn();
    render(
      <ChatPanelHeader
        isMaximized={false}
        onToggleMaximize={onToggleMaximize}
        closeButtonRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: '最大化' });
    expect(button).not.toHaveAttribute('aria-pressed');
    expect(button).toHaveAttribute('title', '画面幅いっぱいに広げる');
    await user.click(button);
    expect(onToggleMaximize).toHaveBeenCalledTimes(1);
  });

  it('shows "縮小" when maximized, with the restore title', () => {
    render(
      <ChatPanelHeader
        isMaximized
        onToggleMaximize={vi.fn()}
        closeButtonRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: '縮小' });
    expect(button).toHaveAttribute('title', '元の幅に戻す');
  });

  it('calls onClose on the close button click and attaches closeButtonRef to it', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const closeButtonRef = createRef<HTMLButtonElement>();
    render(
      <ChatPanelHeader
        isMaximized={false}
        onToggleMaximize={vi.fn()}
        closeButtonRef={closeButtonRef}
        onClose={onClose}
      />,
    );
    const button = screen.getByRole('button', { name: '閉じる' });
    expect(closeButtonRef.current).toBe(button);
    await user.click(button);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('places the maximize/close buttons inside .detail-header-actions', () => {
    render(
      <ChatPanelHeader
        isMaximized={false}
        onToggleMaximize={vi.fn()}
        closeButtonRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
      />,
    );
    const maximize = screen.getByRole('button', { name: '最大化' });
    const close = screen.getByRole('button', { name: '閉じる' });
    expect(maximize.parentElement?.className).toContain('detail-header-actions');
    expect(close.parentElement).toBe(maximize.parentElement);
    expect(screen.getByText('チャット')).toHaveAttribute('id', 'chat-panel-title');
  });
});
