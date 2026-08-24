import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiQuotaWidget } from './AiQuotaWidget';
import type { AiQuotaDto } from '../api';

function renderWidget() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AiQuotaWidget />
    </QueryClientProvider>,
  );
}

function installFetchMock(response: AiQuotaDto | 'network-error'): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/ai-quota') {
      if (response === 'network-error') {
        throw new Error('network down');
      }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AiQuotaWidget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders percent + reset time chips for providers with live metrics', async () => {
    const user = userEvent.setup();
    installFetchMock({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [
        {
          id: 'agy',
          label: 'Antigravity (Gemini sub)',
          vendor: 'Google',
          plan: 'Google AI Pro',
          availability: 'live',
          metrics: [
            {
              label: 'GEMINI MODELS Weekly Limit Remaining',
              percentRemaining: 92,
              resetInText: '88h 21m',
              resetAt: '2026-08-18T16:21:00.000Z',
            },
            {
              label: 'CLAUDE AND GPT MODELS Five Hour Limit Remaining',
              status: 'available',
            },
            { label: 'Credits', valueText: '25 credits' },
          ],
        },
      ],
    });

    renderWidget();

    expect(await screen.findByRole('button', { name: 'AIクォータ 8%使用' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'AIクォータ 8%使用' }));

    expect(screen.getByText('agy')).toBeInTheDocument();
    expect(screen.getByText('週次 92%')).toBeInTheDocument();
    expect(screen.getByText('5時間 空きあり')).toBeInTheDocument();
    expect(screen.getByText('Credits 25 credits')).toBeInTheDocument();
  });

  it('renders nothing while there is no data yet', () => {
    installFetchMock({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [],
    });

    const { container } = renderWidget();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the API reports an error state', async () => {
    installFetchMock({
      state: 'error',
      message: 'ai-quota exited with code 127',
    });

    const { container } = renderWidget();
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('renders nothing when the fetch itself fails', async () => {
    installFetchMock('network-error');

    const { container } = renderWidget();
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('renders only manual providers, hides providers whose auto-fetch failed', async () => {
    const user = userEvent.setup();
    installFetchMock({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [
        {
          id: 'agy',
          label: 'Antigravity (Gemini sub)',
          vendor: 'Google',
          plan: 'Google AI Pro',
          availability: 'live',
          metrics: [
            {
              label: 'GEMINI MODELS Weekly Limit Remaining',
              percentRemaining: 100,
            },
          ],
        },
        {
          id: 'claude',
          label: 'Claude Code (claude.ai sub)',
          vendor: 'Anthropic',
          availability: 'manual',
          detail: '自動取得未対応。確認方法: claude セッション内で `/usage`。',
          metrics: [],
        },
        {
          id: 'codex',
          label: 'Codex (ChatGPT sub)',
          vendor: 'OpenAI',
          availability: 'unavailable',
          detail: 'ライブ取得できず。確認方法: codex 起動 → `/status`。',
          metrics: [],
        },
      ],
    });

    renderWidget();
    await user.click(await screen.findByRole('button', { name: 'AIクォータ 0%使用' }));

    expect(screen.getByText('agy')).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    await user.click(screen.getByText('手動確認'));
    expect(screen.getByText(/自動取得未対応.*\/usage/)).toBeInTheDocument();
    expect(screen.queryByText('codex')).not.toBeInTheDocument();
    expect(screen.queryByText('取得失敗')).not.toBeInTheDocument();
  });

  it('renders nothing if an empty provider response reaches the UI', async () => {
    installFetchMock({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [],
    });

    const { container } = renderWidget();
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('renders nothing when all providers are unavailable (no live metrics)', async () => {
    installFetchMock({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [
        {
          id: 'codex',
          label: 'Codex (ChatGPT sub)',
          vendor: 'OpenAI',
          availability: 'unavailable',
          detail: 'ライブ取得できず。確認方法: codex 起動 → `/status`。',
          metrics: [],
        },
        {
          id: 'cursor',
          label: 'Cursor',
          vendor: 'Cursor',
          availability: 'unavailable',
          detail: 'ライブ取得できず。',
          metrics: [],
        },
      ],
    });

    const { container } = renderWidget();
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });
});
