// bdboard-jlts: チケットからチャットを開いたときの入力欄へのフォーカスを、StrictMode 下で
// 固定する。web/src/main.tsx は <StrictMode> でレンダーするので、開発ビルドでは effect が
// mount → cleanup → mount と二重に走る。以前の useTicketContextLaunch(E9、
// chat/useTicketContextLaunch.ts)は、1回目で予約した rAF の focus を cleanup で取り消し、
// 2回目は「この token は適用済み」で早期 return していたため、フォーカスが当たらなかった
// (本番ビルドでは起きない)。StrictMode でない同じ経路は ChatPanel.draft-carry.test.tsx の
// 特性テスト T3 が固定している。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックと beforeEach/afterEach を複製している。

import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto, ProjectDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { ChatPanel } from './ChatPanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchChatAgents: vi.fn(() => Promise.resolve<ChatAgentDto[]>([])),
    fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])),
    fetchChatTurnStatus: vi.fn(() => Promise.resolve<ChatTurnStatusDto>({ state: 'idle' })),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
    fetchDiscoveredChatSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    fetchPlatformSupport: vi.fn(() => Promise.resolve({ platform: 'darwin', limitations: [] })),
  };
});

import {
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  acknowledgeChatTurn,
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { PROJECT_A, PROJECT_B, CLAUDE_AGENT, openChatSettings } from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

const PREFILL = 'bdboard-x.1 について: ';

function renderStrictChatPanel(projects: readonly ProjectDto[], initialProjectId: string) {
  const view = render(
    <StrictMode>
      <ChatPanel
        projects={projects}
        initialProjectId={initialProjectId}
        initialInput={PREFILL}
        ticketContextToken={1}
        isTicketOnBoard={() => false}
        onOpenTicket={vi.fn()}
        onClose={vi.fn()}
      />
    </StrictMode>,
  );
  openChatSettings(view.container);
  return view;
}

describe('ChatPanel: ticket launch focus under StrictMode (bdboard-jlts)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
    fetchDiscoveredChatSessionsMock.mockResolvedValue({ sessions: [] });
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.reject(new Error(`Unexpected fetch: GET ${url}`))));
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: モックを reset する前にアンマウントし、E8 のポーリングが
    // 次のテストへ持ち越されないようにする。
    try {
      cleanup();
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  it('focuses the textarea and puts the caret at the prefill end after a ticket launch', async () => {
    renderStrictChatPanel([PROJECT_A], 'proj-a');

    const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
    await waitFor(() => {
      expect(textarea).toHaveValue(PREFILL);
      expect(textarea).toHaveFocus();
      expect(textarea.selectionStart).toBe(PREFILL.length);
      expect(textarea.selectionEnd).toBe(PREFILL.length);
    });
  });

  it('focuses the textarea when the ticket project is missing and the launch falls back to another project (S2)', async () => {
    renderStrictChatPanel([PROJECT_B], 'proj-missing');

    expect(
      await screen.findByText(
        'チケットのプロジェクト(id: proj-missing)が見つからないため、「Project Beta」で開いています。この内容は「Project Beta」に対して送信されます。',
      ),
    ).toBeInTheDocument();
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
    await waitFor(() => {
      expect(textarea).toHaveValue(PREFILL);
      expect(textarea).toHaveFocus();
    });
  });
});
