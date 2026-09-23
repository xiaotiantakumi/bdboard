import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppOverlayGroupProps } from './AppOverlayGroup';

// bdboard-62p4 第4段: AppOverlayGroup は7つの状態を持たないオーバーレイ
// (AppTicketDetailOverlay 〜 AppChatOverlay) を `{...group}` でそのまま
// スプレッドして描画するだけの配線コンポーネント。各子をモックに置き換え、
// AppOverlayGroup へ渡したグループ化 props が値・参照ともそのまま(すり替え
// なく)転送されることを vi.mocked(X).mock.calls で直接検証する
// (AppViewContent.test.tsx / AppHeader.test.tsx と同じ手法)。
vi.mock('./AppTicketDetailOverlay', () => ({
  AppTicketDetailOverlay: vi.fn(() => <div data-testid="ticket-detail-overlay" />),
}));
vi.mock('./AppSessionListOverlay', () => ({
  AppSessionListOverlay: vi.fn(() => <div data-testid="session-list-overlay" />),
}));
vi.mock('./AppShortcutsOverlay', () => ({
  AppShortcutsOverlay: vi.fn(() => <div data-testid="shortcuts-overlay" />),
}));
vi.mock('./AppHelpOverlay', () => ({
  AppHelpOverlay: vi.fn(() => <div data-testid="help-overlay" />),
}));
vi.mock('./AppSearchOverlay', () => ({
  AppSearchOverlay: vi.fn(() => <div data-testid="search-overlay" />),
}));
vi.mock('./AppTunnelOverlay', () => ({
  AppTunnelOverlay: vi.fn(() => <div data-testid="tunnel-overlay" />),
}));
vi.mock('./AppChatOverlay', () => ({
  AppChatOverlay: vi.fn(() => <div data-testid="chat-overlay" />),
}));

import { AppTicketDetailOverlay } from './AppTicketDetailOverlay';
import { AppSessionListOverlay } from './AppSessionListOverlay';
import { AppShortcutsOverlay } from './AppShortcutsOverlay';
import { AppHelpOverlay } from './AppHelpOverlay';
import { AppSearchOverlay } from './AppSearchOverlay';
import { AppTunnelOverlay } from './AppTunnelOverlay';
import { AppChatOverlay } from './AppChatOverlay';
import { AppOverlayGroup } from './AppOverlayGroup';

const ticketDetailMock = vi.mocked(AppTicketDetailOverlay);
const sessionListMock = vi.mocked(AppSessionListOverlay);
const shortcutsMock = vi.mocked(AppShortcutsOverlay);
const helpMock = vi.mocked(AppHelpOverlay);
const searchMock = vi.mocked(AppSearchOverlay);
const tunnelMock = vi.mocked(AppTunnelOverlay);
const chatMock = vi.mocked(AppChatOverlay);

function makeProps(): AppOverlayGroupProps {
  return {
    ticketDetail: {
      selectedTicketId: 'ticket-marker',
      projectRootPaths: new Map([['proj-1', '/root/proj-1']]),
      pendingDecision: undefined,
      prLink: undefined,
      onClose: vi.fn(),
      onChatAboutTicket: vi.fn(),
      onOpenTicket: vi.fn(),
      onBackTicket: vi.fn(),
      isMaximized: true,
      onToggleMaximized: vi.fn(),
      isTicketOnBoard: vi.fn(),
      onFilterByEpic: vi.fn(),
      onTicketViewed: vi.fn(),
      availableLabels: ['label-marker'],
    },
    sessionList: {
      open: true,
      projectId: 'session-project-marker',
      onClose: vi.fn(),
    },
    shortcuts: {
      open: true,
      onClose: vi.fn(),
    },
    help: {
      open: true,
      onClose: vi.fn(),
    },
    search: {
      open: true,
      onClose: vi.fn(),
      onSelect: vi.fn(),
      actions: [],
      recentTickets: [],
    },
    tunnel: {
      open: true,
      onClose: vi.fn(),
    },
    chat: {
      open: true,
      projects: [],
      initialProjectId: 'chat-project-marker',
      initialInput: 'chat-input-marker',
      ticketContextToken: 42,
      onProjectIdChange: vi.fn(),
      isTicketOnBoard: vi.fn(),
      onOpenTicket: vi.fn(),
      onClose: vi.fn(),
    },
  };
}

describe('AppOverlayGroup', () => {
  it('forwards ticketDetail through unchanged', () => {
    const props = makeProps();
    render(<AppOverlayGroup {...props} />);

    expect(ticketDetailMock.mock.calls.at(-1)?.[0]).toEqual(props.ticketDetail);
  });

  it('forwards sessionList through unchanged', () => {
    const props = makeProps();
    render(<AppOverlayGroup {...props} />);

    expect(sessionListMock.mock.calls.at(-1)?.[0]).toEqual(props.sessionList);
  });

  it('forwards shortcuts through unchanged', () => {
    const props = makeProps();
    render(<AppOverlayGroup {...props} />);

    expect(shortcutsMock.mock.calls.at(-1)?.[0]).toEqual(props.shortcuts);
  });

  it('forwards help through unchanged', () => {
    const props = makeProps();
    render(<AppOverlayGroup {...props} />);

    expect(helpMock.mock.calls.at(-1)?.[0]).toEqual(props.help);
  });

  it('forwards search through unchanged', () => {
    const props = makeProps();
    render(<AppOverlayGroup {...props} />);

    expect(searchMock.mock.calls.at(-1)?.[0]).toEqual(props.search);
  });

  it('forwards tunnel through unchanged', () => {
    const props = makeProps();
    render(<AppOverlayGroup {...props} />);

    expect(tunnelMock.mock.calls.at(-1)?.[0]).toEqual(props.tunnel);
  });

  it('forwards chat through unchanged', () => {
    const props = makeProps();
    render(<AppOverlayGroup {...props} />);

    expect(chatMock.mock.calls.at(-1)?.[0]).toEqual(props.chat);
  });
});
