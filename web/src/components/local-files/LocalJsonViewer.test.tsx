import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonViewer } from './LocalJsonViewer';

const TICKET_ID = 'video-p4q.38';
const PATH = 'projects/demo/script/scenes.json';
const SCENE_JSON = '{"scenes":[{"id":"s01"},{"id":"s02"}],"title":"demo"}';

function renderViewer(body: string, nodeLimit?: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status: 200 })),
  );
  return render(
    <QueryClientProvider client={client}>
      <LocalJsonViewer ticketId={TICKET_ID} path={PATH} nodeLimit={nodeLimit} />
    </QueryClientProvider>,
  );
}

describe('LocalJsonViewer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders objects as details that close when the summary is clicked', async () => {
    const user = userEvent.setup();
    renderViewer(SCENE_JSON);

    const details = await screen.findAllByRole('group');
    expect(details.length).toBeGreaterThan(0);
    expect(details[0]).toHaveAttribute('open');
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('"demo"')).toBeInTheDocument();

    const summary = details[0]?.querySelector('summary');
    expect(summary).not.toBeNull();
    await user.click(summary as HTMLElement);
    expect(details[0]).not.toHaveAttribute('open');
  });

  it('notes that only the first nodes are shown when the tree exceeds the limit', async () => {
    renderViewer(SCENE_JSON, 3);
    expect(await screen.findByText('大きいため先頭の 3 項目だけ表示しています。')).toBeInTheDocument();
  });

  it('shows the raw text when the body is not JSON', async () => {
    const raw = '{scenes: not-json';
    renderViewer(raw);
    expect(await screen.findByText('JSON として読めなかったので、そのまま表示しています。')).toBeInTheDocument();
    const pre = screen.getByText(raw);
    expect(pre.tagName).toBe('PRE');
    expect(pre).toHaveClass('local-file-viewer-text');
  });
});
