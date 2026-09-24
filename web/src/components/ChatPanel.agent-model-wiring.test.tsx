import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { fetchChatAgents, fetchChatThreads, fetchChatTurnStatus } from '../api';
import { PROJECT_A, renderChatPanel } from './ChatPanel-test-support';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchChatAgents: vi.fn(() => Promise.resolve<ChatAgentDto[]>([])),
    fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])),
    fetchChatTurnStatus: vi.fn(() => Promise.resolve<ChatTurnStatusDto>({ state: 'idle' })),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
    deleteChatThread: vi.fn(() => Promise.resolve()),
    updateChatThread: vi.fn(() => Promise.resolve({})),
    fetchDiscoveredChatSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    fetchPlatformSupport: vi.fn(() => Promise.resolve({ platform: 'darwin', limitations: [] })),
  };
});

import { resetPlatformSupportCache } from './PlatformLimitationNotice';

const markerAgent: ChatAgentDto = {
  id: 'marker-agent',
  label: 'Marker Agent',
  model: 'marker-model',
  models: [
    { id: 'marker-model', label: 'Marker Model' },
    { id: 'alternate-model', label: 'Alternate Model' },
  ],
  experimental: false,
  capability: 'bd-only',
  availability: 'available',
  supportsStreaming: false,
  supportsImages: false,
};

describe('ChatPanel agent model wiring', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    vi.mocked(fetchChatAgents).mockResolvedValue([markerAgent]);
    vi.mocked(fetchChatThreads).mockResolvedValue([]);
    vi.mocked(fetchChatTurnStatus).mockResolvedValue({ state: 'idle' });
    resetPlatformSupportCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('renders the fetched agent and its effective model from the extracted hook', async () => {
    renderChatPanel([PROJECT_A]);
    await waitFor(() => expect(vi.mocked(fetchChatAgents)).toHaveBeenCalled());
    expect(await screen.findByLabelText('チャットエージェント')).toHaveValue('marker-agent');
    expect(screen.getByLabelText('モデル')).toHaveValue('marker-model');
  });
});
