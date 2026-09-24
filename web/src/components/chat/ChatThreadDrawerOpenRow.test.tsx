// bdboard-sso1.83 第6段: ChatThreadDrawerOpenRow 抽出時に足した、コンポーネント単体の
// レンダリング/操作テスト。ChatPanel を経由せず actions を vi.fn() で直接検証することで、
// IME ガード・メニュー開閉・削除確認2段階などの分岐を ChatPanel の起動コストなしで
// 素早く固定する(ChatPanel 統合テストは ChatPanel.thread-ops-and-messages.test.tsx 側の
// 既存テスト+T1 が引き続き担う)。
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { ChatThreadDrawerOpenRow, type ThreadDrawerRowActions } from './ChatThreadDrawerOpenRow';

const THREAD: ChatThreadDto = {
  sessionId: 'sess-marker-open',
  agentId: 'claude',
  title: 'marker thread',
  pinned: false,
  updatedAt: '2026-01-02T00:00:00Z',
};

function makeActions(overrides: Partial<ThreadDrawerRowActions> = {}): ThreadDrawerRowActions {
  return {
    select: vi.fn(),
    reopenClosed: vi.fn(),
    changeRenameDraft: vi.fn(),
    confirmRename: vi.fn(),
    cancelRename: vi.fn(),
    toggleMenu: vi.fn(),
    startRename: vi.fn(),
    togglePin: vi.fn(),
    closeThread: vi.fn(),
    startConfirmDelete: vi.fn(),
    deleteThread: vi.fn(),
    ...overrides,
  };
}

describe('ChatThreadDrawerOpenRow', () => {
  it('renders the title, meta (updated-at + agent label), and calls select(sessionId) on click', async () => {
    const user = userEvent.setup();
    const actions = makeActions();
    render(
      <ChatThreadDrawerOpenRow
        sessionId={THREAD.sessionId}
        thread={THREAD}
        agentLabel="Claude"
        isSelected={false}
        isRenaming={false}
        renameDraft=""
        isMenuOpen={false}
        isConfirmingDelete={false}
        actions={actions}
      />,
    );
    const selectButton = document.querySelector('.chat-thread-drawer-item-select');
    if (!(selectButton instanceof HTMLElement)) throw new Error('select button not found');
    expect(selectButton).toHaveTextContent('marker thread');
    expect(selectButton.querySelector('.chat-thread-drawer-item-meta')).toHaveTextContent('Claude');
    await user.click(selectButton);
    expect(actions.select).toHaveBeenCalledWith('sess-marker-open');
  });

  it('shows the pin marker only when the thread is pinned', () => {
    const { rerender } = render(
      <ChatThreadDrawerOpenRow
        sessionId={THREAD.sessionId}
        thread={THREAD}
        isSelected={false}
        isRenaming={false}
        renameDraft=""
        isMenuOpen={false}
        isConfirmingDelete={false}
        actions={makeActions()}
      />,
    );
    expect(document.querySelector('.chat-thread-drawer-item-pin')).not.toBeInTheDocument();
    rerender(
      <ChatThreadDrawerOpenRow
        sessionId={THREAD.sessionId}
        thread={{ ...THREAD, pinned: true }}
        isSelected={false}
        isRenaming={false}
        renameDraft=""
        isMenuOpen={false}
        isConfirmingDelete={false}
        actions={makeActions()}
      />,
    );
    expect(document.querySelector('.chat-thread-drawer-item-pin')).toBeInTheDocument();
  });

  it('menu toggle calls toggleMenu(sessionId), and the menu items call the matching action with the sessionId', async () => {
    const user = userEvent.setup();
    const actions = makeActions();
    render(
      <ChatThreadDrawerOpenRow
        sessionId={THREAD.sessionId}
        thread={THREAD}
        isSelected={false}
        isRenaming={false}
        renameDraft=""
        isMenuOpen={false}
        isConfirmingDelete={false}
        actions={actions}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'スレッド「marker thread」の操作' }));
    expect(actions.toggleMenu).toHaveBeenCalledWith('sess-marker-open');
  });

  it('opened menu: rename/pin/close/delete-start items call the correct actions with the sessionId', async () => {
    const user = userEvent.setup();
    const actions = makeActions();
    render(
      <ChatThreadDrawerOpenRow
        sessionId={THREAD.sessionId}
        thread={THREAD}
        isSelected={false}
        isRenaming={false}
        renameDraft=""
        isMenuOpen
        isConfirmingDelete={false}
        actions={actions}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'スレッド「marker thread」の操作メニュー' });
    await user.click(within(menu).getByRole('menuitem', { name: 'リネーム' }));
    expect(actions.startRename).toHaveBeenCalledWith('sess-marker-open', 'marker thread');

    await user.click(within(menu).getByRole('menuitem', { name: 'ピン留め' }));
    expect(actions.togglePin).toHaveBeenCalledWith('sess-marker-open', false);

    await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));
    expect(actions.closeThread).toHaveBeenCalledWith('sess-marker-open');

    await user.click(within(menu).getByRole('menuitem', { name: '削除' }));
    expect(actions.startConfirmDelete).toHaveBeenCalledWith('sess-marker-open');
  });

  it('when confirming delete, the menu shows "本当に削除" and calls deleteThread(sessionId)', async () => {
    const user = userEvent.setup();
    const actions = makeActions();
    render(
      <ChatThreadDrawerOpenRow
        sessionId={THREAD.sessionId}
        thread={THREAD}
        isSelected={false}
        isRenaming={false}
        renameDraft=""
        isMenuOpen
        isConfirmingDelete
        actions={actions}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'スレッド「marker thread」の操作メニュー' });
    expect(within(menu).queryByRole('menuitem', { name: '削除' })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: '本当に削除' }));
    expect(actions.deleteThread).toHaveBeenCalledWith('sess-marker-open');
  });

  it('rename input: Enter (non-IME) confirms, IME-composing Enter does nothing, Escape cancels, blur confirms', () => {
    const actions = makeActions();
    render(
      <ChatThreadDrawerOpenRow
        sessionId={THREAD.sessionId}
        thread={THREAD}
        isSelected={false}
        isRenaming
        renameDraft="draft text"
        isMenuOpen={false}
        isConfirmingDelete={false}
        actions={actions}
      />,
    );
    const input = screen.getByLabelText('スレッド「marker thread」の新しいタイトル');
    fireEvent.change(input, { target: { value: 'edited' } });
    expect(actions.changeRenameDraft).toHaveBeenCalledWith('edited');

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(actions.confirmRename).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(actions.cancelRename).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(actions.confirmRename).toHaveBeenCalledWith('sess-marker-open');

    fireEvent.blur(input);
    expect(actions.confirmRename).toHaveBeenCalledTimes(2);
  });

  it('falls back to "(無題)" when thread is undefined, and startRename receives an empty initial title', async () => {
    const user = userEvent.setup();
    const actions = makeActions();
    render(
      <ChatThreadDrawerOpenRow
        sessionId="sess-marker-untitled"
        isSelected={false}
        isRenaming={false}
        renameDraft=""
        isMenuOpen
        isConfirmingDelete={false}
        actions={actions}
      />,
    );
    expect(screen.getByRole('button', { name: '(無題)' })).toBeInTheDocument();
    const menu = screen.getByRole('menu', { name: 'スレッド「(無題)」の操作メニュー' });
    await user.click(within(menu).getByRole('menuitem', { name: 'リネーム' }));
    expect(actions.startRename).toHaveBeenCalledWith('sess-marker-untitled', '');
  });
});
