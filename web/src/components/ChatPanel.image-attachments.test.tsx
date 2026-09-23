// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.image-attachments.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { expectNoA11yViolations } from '../test/axe';
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
    deleteChatThread: vi.fn(() => Promise.resolve()),
    updateChatThread: vi.fn(() =>
      Promise.resolve<ChatThreadDto>({
        sessionId: 'sess-1',
        agentId: 'claude',
        title: 'updated',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ),
    fetchDiscoveredChatSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    fetchPlatformSupport: vi.fn(() => Promise.resolve({ platform: 'darwin', limitations: [] })),
  };
});

import {
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  acknowledgeChatTurn,
  deleteChatThread,
  updateChatThread,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const deleteChatThreadMock = vi.mocked(deleteChatThread);
const updateChatThreadMock = vi.mocked(updateChatThread);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);
const defaultWindowInnerWidth = window.innerWidth;

import {
  PROJECT_A,
  PROJECT_B,
  CODEX_IMAGE_AGENT,
  EXAMPLE_AGENT,
  IMAGE_STREAMING_AGENT,
  jsonResponse,
  parseChatMessageBody,
  pasteFiles,
  selectFiles,
  getImageFileInput,
  makeImageFile,
  openThreadDrawer,
  getThreadDrawer,
  selectThreadFromDrawer,
  renderChatPanel,
} from './ChatPanel-test-support';

describe('ChatPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
    deleteChatThreadMock.mockResolvedValue();
    updateChatThreadMock.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'claude',
      title: 'updated',
      pinned: false,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'AI reply',
          sessionId: 'sess-default',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: defaultWindowInnerWidth,
    });
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  describe('画像貼り付け', () => {
    it('shows an accessible preview with metadata, preserves normal text paste, and removes one image', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const { container } = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      const input = screen.getByLabelText('メッセージ');

      const textPaste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(textPaste, 'clipboardData', { value: { files: [] } });
      fireEvent(input, textPaste);
      expect(textPaste.defaultPrevented).toBe(false);

      pasteFiles(input, [makeImageFile('board-shot.png')]);

      expect(
        await screen.findByAltText('送信前の添付画像: board-shot.png'),
      ).toBeInTheDocument();
      expect(screen.getByText('board-shot.png')).toBeInTheDocument();
      expect(screen.getByText('1 KiB')).toBeInTheDocument();
      expect(screen.getByText(/localStorage には保存されません/)).toBeInTheDocument();
      expect(localStorage.getItem('bdboard.chat.thread.v2') ?? '').not.toContain('board-shot');
      await expectNoA11yViolations(container);

      await userEvent.setup().click(
        screen.getByRole('button', { name: '添付画像「board-shot.png」を削除' }),
      );
      expect(
        screen.queryByAltText('送信前の添付画像: board-shot.png'),
      ).not.toBeInTheDocument();
    });

    it('keeps a pasted image when projects resolve after a regular cold mount', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const rendered = renderChatPanel([], { initialProjectId: 'proj-b' });
      await screen.findByLabelText('チャットエージェント');

      pasteFiles(screen.getByLabelText('メッセージ'), [makeImageFile('cold.png')]);
      await screen.findByAltText('送信前の添付画像: cold.png');

      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A, PROJECT_B]}
          initialProjectId="proj-b"
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
        expect(screen.getByAltText('送信前の添付画像: cold.png')).toBeInTheDocument();
      });
    });

    it('keeps a cold-window attachment error visible after the project resolves (bdboard-c1pw: attachmentErrors also migrates)', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const rendered = renderChatPanel([], { initialProjectId: 'proj-b' });
      await screen.findByLabelText('チャットエージェント');

      pasteFiles(screen.getByLabelText('メッセージ'), [
        makeImageFile('animated.gif', 'image/gif'),
      ]);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'PNG・JPEG・WebP 形式の画像だけ貼り付けられます。',
      );

      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A, PROJECT_B]}
          initialProjectId="proj-b"
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
        expect(screen.getByRole('alert')).toHaveTextContent(
          'PNG・JPEG・WebP 形式の画像だけ貼り付けられます。',
        );
      });
    });

    it('keeps image-only cold draft when projects arrive via effect with existing threads (major-2 image regression)', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        {
          sessionId: 'sess-existing',
          agentId: 'claude',
          title: '既存スレッド',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/chat/sessions/sess-existing/messages')) {
          return jsonResponse({
            sessionId: 'sess-existing',
            agentId: 'claude',
            messages: [],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const rendered = renderChatPanel([], { leaveSettingsCollapsed: true });
      await screen.findByLabelText('チャットエージェント');

      pasteFiles(screen.getByLabelText('メッセージ'), [makeImageFile('cold-image-only.png')]);
      await screen.findByAltText('送信前の添付画像: cold-image-only.png');

      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A]}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      openThreadDrawer(rendered.container);
      await within(getThreadDrawer(rendered.container)).findByRole('button', {
        name: '既存スレッド',
      });
      expect(
        screen.getByAltText('送信前の添付画像: cold-image-only.png'),
      ).toBeInTheDocument();
    });

    it('keeps a pasted image when a ticket-context project resolves after a cold mount', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const rendered = renderChatPanel([], {
        initialProjectId: 'proj-b',
        initialInput: 'proj-b のチケットについて: ',
        ticketContextToken: 1,
      });
      await screen.findByLabelText('チャットエージェント');

      pasteFiles(screen.getByLabelText('メッセージ'), [makeImageFile('ticket-cold.webp', 'image/webp')]);
      await screen.findByAltText('送信前の添付画像: ticket-cold.webp');

      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A, PROJECT_B]}
          initialProjectId="proj-b"
          initialInput="proj-b のチケットについて: "
          ticketContextToken={1}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
        expect(
          screen.getByAltText('送信前の添付画像: ticket-cold.webp'),
        ).toBeInTheDocument();
      });
    });

    it.each([
      {
        label: 'count',
        files: Array.from({ length: 5 }, (_, index) => makeImageFile(`${index}.png`)),
        message: '画像は最大 4 枚まで添付できます。',
      },
      {
        label: 'per-file size',
        files: [
          makeImageFile(
            'large.png',
            'image/png',
            5 * 1024 * 1024 + 1,
          ),
        ],
        message: '「large.png」は 5 MiB を超えています。',
      },
      {
        label: 'total size',
        files: [
          makeImageFile('a.png', 'image/png', 4 * 1024 * 1024),
          makeImageFile('b.jpg', 'image/jpeg', 4 * 1024 * 1024),
          makeImageFile('c.webp', 'image/webp', 3 * 1024 * 1024),
        ],
        message: '画像の合計サイズは 10 MiB 以下にしてください。',
      },
      {
        label: 'MIME type',
        files: [makeImageFile('animated.gif', 'image/gif')],
        message: 'PNG・JPEG・WebP 形式の画像だけ貼り付けられます。',
      },
    ])('rejects the $label limit atomically with an alert', async ({ files, message }) => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      renderChatPanel([PROJECT_A]);
      const input = screen.getByLabelText('メッセージ');

      pasteFiles(input, files);

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByRole('list', { name: '送信前の添付画像' })).not.toBeInTheDocument();
    });

    it('keeps pasted images but blocks an unsupported agent until switching to an image-capable agent', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([EXAMPLE_AGENT, CODEX_IMAGE_AGENT]);
      renderChatPanel([PROJECT_A]);
      const agentSelect = await screen.findByLabelText('チャットエージェント');
      expect(agentSelect).toHaveTextContent('Example Agent [画像非対応]');
      expect(agentSelect).toHaveTextContent('Codex [画像対応]');

      pasteFiles(screen.getByLabelText('メッセージ'), [makeImageFile('diagram.webp', 'image/webp')]);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        '画像対応エージェントへ切り替えるか、画像を削除してください。',
      );
      expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();

      await user.selectOptions(agentSelect, 'codex');

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(
        screen.getByAltText('送信前の添付画像: diagram.webp'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '送信' })).toBeEnabled();
    });

    it('sends an image-only message with raw base64 and keeps the preview on the optimistic message', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      pasteFiles(screen.getByLabelText('メッセージ'), [
        makeImageFile('only.png', 'image/png', 'png'),
      ]);
      await screen.findByAltText('送信前の添付画像: only.png');

      await user.click(screen.getByRole('button', { name: '送信' }));
      await screen.findByText('AI reply');

      expect(parseChatMessageBody(fetchMock)).toEqual({
        projectId: 'proj-a',
        message: '添付画像の内容を説明してください。',
        agentId: 'codex',
        images: [{ mimeType: 'image/png', data: 'cG5n' }],
      });
      expect(
        within(screen.getByRole('log')).getByText('添付画像の内容を説明してください。'),
      ).toBeInTheDocument();
      expect(within(screen.getByRole('log')).getByAltText('添付画像: only.png')).toBeInTheDocument();
      expect(
        screen.queryByAltText('送信前の添付画像: only.png'),
      ).not.toBeInTheDocument();
    });

    it('restores text and images to the sending conversation after a normal failure', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return jsonResponse({ error: 'image send failed' }, 500);
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });
      renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'inspect this');
      pasteFiles(input, [makeImageFile('restore.jpg', 'image/jpeg')]);
      await screen.findByAltText('送信前の添付画像: restore.jpg');

      await user.click(screen.getByRole('button', { name: '送信' }));
      await screen.findByText('image send failed');

      expect(input).toHaveValue('inspect this');
      expect(
        screen.getByAltText('送信前の添付画像: restore.jpg'),
      ).toBeInTheDocument();
      expect(within(screen.getByRole('log')).queryByText('inspect this')).not.toBeInTheDocument();
      expect(within(screen.getByRole('log')).queryByAltText('添付画像: restore.jpg')).not.toBeInTheDocument();
    });

    it('does not restore image or text drafts after an AbortError', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([IMAGE_STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'codex', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'codex', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'codex', messages: [] });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'codex', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'));
              init.signal?.addEventListener('abort', () => {
                controller.error(new DOMException('aborted', 'AbortError'));
              });
            },
          }));
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });
      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'abort image');
      pasteFiles(input, [makeImageFile('abort.png')]);
      await screen.findByAltText('送信前の添付画像: abort.png');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'second thread');
      await selectThreadFromDrawer(container, user, 'first thread');

      expect(screen.getByLabelText('メッセージ')).toHaveValue('');
      expect(
        screen.queryByAltText('送信前の添付画像: abort.png'),
      ).not.toBeInTheDocument();
      expect(within(screen.getByRole('log')).getByAltText('添付画像: abort.png')).toBeInTheDocument();
      expect(screen.getByRole('log').querySelectorAll('.chat-message-error')).toHaveLength(0);
    });
  });

  describe('画像添付ボタン', () => {
    it('shows a preview when images are selected via the attach button', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const { container } = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');

      const attachButton = screen.getByRole('button', { name: '画像を添付' });
      expect(attachButton).toBeInTheDocument();
      const fileInput = getImageFileInput(container);
      expect(fileInput).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');
      expect(fileInput).toHaveAttribute('multiple');

      selectFiles(fileInput, [makeImageFile('picked.png')]);

      expect(
        await screen.findByAltText('送信前の添付画像: picked.png'),
      ).toBeInTheDocument();
    });

    it('rejects five images selected at once via the attach button', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const { container } = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');

      const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');
      selectFiles(
        getImageFileInput(container),
        Array.from({ length: 5 }, (_, index) => makeImageFile(`${index}.png`)),
      );

      expect(await screen.findByRole('alert')).toHaveTextContent(
        '画像は最大 4 枚まで添付できます。',
      );
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
      expect(screen.queryByRole('list', { name: '送信前の添付画像' })).not.toBeInTheDocument();
    });

    it('rejects unsupported MIME types selected via the attach button', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const { container } = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');

      const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');
      selectFiles(getImageFileInput(container), [
        makeImageFile('animated.gif', 'image/gif'),
      ]);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'PNG・JPEG・WebP 形式の画像だけ貼り付けられます。',
      );
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
      expect(screen.queryByRole('list', { name: '送信前の添付画像' })).not.toBeInTheDocument();
    });

    it('rejects HEIC selected via the attach button', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const { container } = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');

      selectFiles(getImageFileInput(container), [
        makeImageFile('photo.heic', 'image/heic'),
      ]);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'PNG・JPEG・WebP 形式の画像だけ貼り付けられます。',
      );
    });

    it('shares attachment state between paste and attach button paths', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const { container } = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      const messageInput = screen.getByLabelText('メッセージ');

      pasteFiles(messageInput, [
        makeImageFile('paste-1.png'),
        makeImageFile('paste-2.png'),
        makeImageFile('paste-3.png'),
      ]);
      await screen.findByAltText('送信前の添付画像: paste-1.png');
      const attachmentList = screen.getByRole('list', { name: '送信前の添付画像' });
      expect(within(attachmentList).getAllByRole('listitem')).toHaveLength(3);

      const readSpy = vi.spyOn(FileReader.prototype, 'readAsDataURL');
      selectFiles(getImageFileInput(container), [
        makeImageFile('pick-1.png'),
        makeImageFile('pick-2.png'),
      ]);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        '画像は最大 4 枚まで添付できます。',
      );
      expect(readSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
      expect(within(attachmentList).getAllByRole('listitem')).toHaveLength(3);
    });

    it('allows selecting the same file twice in a row via the attach button', async () => {
      fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
      const { container } = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      const fileInput = getImageFileInput(container);
      const sameFile = makeImageFile('repeat.png');

      selectFiles(fileInput, [sameFile]);
      await screen.findByAltText('送信前の添付画像: repeat.png');
      const attachmentList = screen.getByRole('list', { name: '送信前の添付画像' });
      expect(within(attachmentList).getAllByRole('listitem')).toHaveLength(1);

      selectFiles(fileInput, [sameFile]);
      await waitFor(() => {
        expect(within(attachmentList).getAllByRole('listitem')).toHaveLength(2);
      });
    });
  });
});
