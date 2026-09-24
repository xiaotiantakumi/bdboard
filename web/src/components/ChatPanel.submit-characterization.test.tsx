// bdboard-sso1.83 第13b段の「先に足すもの」: 送信本体(submitChatMessage/handleSubmit)を
// chat/useChatSubmit.ts へ移す前に、今の main の挙動をこのファイルで固定する。
// - T4 補助: 送信の finally が textarea の focus() を呼ぶこと自体は今もある。効かない
//   のは、呼んだ時点の textarea がまだ disabled だから(bdboard-dcyi、T4 は it.fails の
//   まま)。ここでは「呼ばれる/その瞬間は disabled」を固定し、finally の中の
//   setIsSending(false) → focus() の順と同期性が移動で変わらないことを見る。
// - T5 補助: 失敗で終わった送信でも「考え中…N秒」が消える(finally の isSending=false)。
// - ガード: 利用不可エージェントの判定は空入力の判定より先に来るが、空入力(本文も添付も
//   無い)ならエラーバブルも積まない。
// - リクエスト本文のキー順(projectId, message, sessionId, agentId, model)。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックと beforeEach/afterEach を複製している。

import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { CHAT_AGENT_UNAVAILABLE_WARNING } from '../writeAccessMessage';

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
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import {
  PROJECT_A,
  CLAUDE_AGENT,
  createDeferred,
  jsonResponse,
  getChatMessagePostCalls,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

describe('ChatPanel submit characterization (bdboard-sso1.83 第13b段の前提)', () => {
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
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ reply: 'AI reply', sessionId: 'sess-default', agentId: 'claude' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  // focus() が呼ばれた瞬間の textarea.disabled を記録する(呼び出し自体は素通しする)。
  function recordFocusCalls(textarea: HTMLTextAreaElement): boolean[] {
    const disabledAtCall: boolean[] = [];
    const originalFocus = HTMLTextAreaElement.prototype.focus;
    vi.spyOn(textarea, 'focus').mockImplementation(function (this: HTMLTextAreaElement, options?: FocusOptions) {
      disabledAtCall.push(this.disabled);
      originalFocus.call(this, options);
    });
    return disabledAtCall;
  }

  it('calls textarea.focus() exactly once in the send finally after a success, while the textarea is still disabled (T4 補助、bdboard-dcyi)', async () => {
    const user = userEvent.setup();
    renderChatPanel([PROJECT_A]);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
    await user.type(textarea, 'focus attempt');
    const disabledAtCall = recordFocusCalls(textarea);

    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(within(screen.getByRole('log')).getByText('AI reply')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(textarea).not.toBeDisabled();
    });
    expect(disabledAtCall).toEqual([true]);
  });

  it('calls textarea.focus() exactly once in the send finally after a failure, too (T4 補助)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ error: 'boom' }, 500);
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    renderChatPanel([PROJECT_A]);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
    await user.type(textarea, 'focus after failure');
    const disabledAtCall = recordFocusCalls(textarea);

    await user.click(screen.getByRole('button', { name: '送信' }));

    await screen.findByText('boom');
    await waitFor(() => {
      expect(textarea).not.toBeDisabled();
    });
    expect(disabledAtCall).toEqual([true]);
  });

  it('clears 考え中…N秒 once a failed send settles (T5 補助: finally の isSending=false)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      await user.type(screen.getByLabelText('メッセージ'), 'timed failure');
      await user.click(screen.getByRole('button', { name: '送信' }));
      expect(screen.getByText('考え中…0秒（最大3分かかることがあります）')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByText('考え中…1秒（最大3分かかることがあります）')).toBeInTheDocument();

      deferred.resolve(jsonResponse({ error: 'late boom' }, 500));
      await screen.findByText('late boom');
      expect(screen.queryByText(/考え中…\d+秒/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('メッセージ')).toHaveValue('timed failure');
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds no error bubble and posts nothing on ⌘Enter with an empty input while the agent is unavailable (guard: 空入力はバブルも積まない)', async () => {
    fetchChatAgentsMock.mockResolvedValue([{ ...CLAUDE_AGENT, availability: 'unavailable' }]);
    const user = userEvent.setup();
    renderChatPanel([PROJECT_A]);
    await screen.findByText(CHAT_AGENT_UNAVAILABLE_WARNING);

    await user.click(screen.getByLabelText('メッセージ'));
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    expect(getChatMessagePostCalls(fetchMock)).toEqual([]);
    expect(screen.getByRole('log').querySelector('.chat-message-error')).toBeNull();
  });

  it('serializes the request body keys in the order projectId, message, sessionId, agentId, model', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ reply: 'ordered reply', sessionId: 'sess-order', agentId: 'claude' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    const user = userEvent.setup();
    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('モデル');

    await user.type(screen.getByLabelText('メッセージ'), 'first');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('ordered reply');
    await user.type(screen.getByLabelText('メッセージ'), 'second');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(2);
    });
    const bodies = getChatMessagePostCalls(fetchMock).map(([, init]) => (init as RequestInit).body);
    expect(bodies).toEqual([
      '{"projectId":"proj-a","message":"first","agentId":"claude","model":"sonnet"}',
      '{"projectId":"proj-a","message":"second","sessionId":"sess-order","agentId":"claude","model":"sonnet"}',
    ]);
  });
});
