import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
    installFetchMock({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [
        {
          id: 'agy',
          label: 'Antigravity (Gemini sub)',
          vendor: 'Google',
          plan: 'Google AI Pro',
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
          ],
        },
      ],
    });

    renderWidget();

    await screen.findByText('agy');
    expect(screen.getByText('週次 92%')).toBeInTheDocument();
    expect(screen.getByText('5時間 空きあり')).toBeInTheDocument();
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

  it('hides itself (renders nothing) when the API reports an error state', async () => {
    const fetchMock = installFetchMock({
      state: 'error',
      message: 'ai-quota exited with code 127',
    });

    const { container } = renderWidget();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hides itself when the fetch itself fails (command missing, network error, etc.)', async () => {
    const fetchMock = installFetchMock('network-error');

    const { container } = renderWidget();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hides itself when there are no providers with live metrics', async () => {
    const fetchMock = installFetchMock({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [],
    });

    const { container } = renderWidget();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
