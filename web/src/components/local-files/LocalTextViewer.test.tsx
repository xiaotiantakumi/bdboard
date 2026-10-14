import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalTextViewer } from './LocalTextViewer';

const TICKET_ID = 'video-p4q.38';
const PATH = 'projects/demo/script/review.md';
const RAW_URL = `/api/tickets/${encodeURIComponent(TICKET_ID)}/local-files/raw?path=${encodeURIComponent(PATH)}`;

function renderViewer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalTextViewer ticketId={TICKET_ID} path={PATH} />
    </QueryClientProvider>,
  );
}

describe('LocalTextViewer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the raw text in a pre element', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(RAW_URL);
      return new Response('# review\nline', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderViewer();

    const pre = await screen.findByText('# review line');
    expect(pre.tagName).toBe('PRE');
    expect(pre).toHaveClass('local-file-viewer-text');
    expect(fetchMock).toHaveBeenCalledWith(RAW_URL, undefined);
  });

  it('shows the too-large message when raw returns 413', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'too large' }), {
          status: 413,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    renderViewer();

    expect(await screen.findByRole('alert')).toHaveTextContent('ファイルが大きすぎて表示できません。');
  });
});
