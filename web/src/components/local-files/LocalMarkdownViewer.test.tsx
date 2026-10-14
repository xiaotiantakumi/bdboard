import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMarkdownViewer } from './LocalMarkdownViewer';

const TICKET_ID = 'video-p4q.38';
const PATH = 'projects/demo/script/review.md';

function renderViewer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalMarkdownViewer ticketId={TICKET_ID} path={PATH} />
    </QueryClientProvider>,
  );
}

describe('LocalMarkdownViewer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders markdown as a heading and a list item, not a pre', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('# 見出し\n\n- 項目\n', { status: 200 })),
    );
    renderViewer();

    expect(await screen.findByRole('heading', { name: '見出し' })).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveTextContent('項目');
    expect(document.querySelector('pre')).toBeNull();
  });
});
