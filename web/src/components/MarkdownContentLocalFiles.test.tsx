import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from './MarkdownContent';
import { TicketLocalFileLinksProvider } from './local-files/TicketLocalFileLinks';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function renderWithFiles(text: string, files: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ files }), { status: 200 })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TicketLocalFileLinksProvider ticketId="bdboard-abc">
        <MarkdownContent text={text} isTicketOnBoard={() => false} onOpenTicket={() => {}} />
      </TicketLocalFileLinksProvider>
    </QueryClientProvider>,
  );
}

describe('MarkdownContent local file links (bdboard-32vv)', () => {
  it('turns a resolved path into a button that opens the viewer like the file list', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderWithFiles('動画を確認して: out/foo/final.mp4', [
      { path: 'out/foo/final.mp4', kind: 'video', size: 1234 },
    ]);

    const button = await screen.findByRole('button', { name: 'out/foo/final.mp4' });
    await userEvent.click(button);

    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0] ?? [];
    expect(String(url)).toContain('view=local-file');
    expect(String(url)).toContain('ticket=bdboard-abc');
    expect(String(url)).toContain('path=out%2Ffoo%2Ffinal.mp4');
    expect(String(url)).toContain('kind=video');
    expect(target).toBe('_blank');
    expect(features).toBe('noopener');
  });

  it('leaves unresolved paths as plain text', async () => {
    renderWithFiles('see missing/x.mp4', []);
    await waitFor(() => expect(screen.getByText('see missing/x.mp4')).toBeInTheDocument());
    expect(screen.queryByRole('button')).toBeNull();
  });
});
