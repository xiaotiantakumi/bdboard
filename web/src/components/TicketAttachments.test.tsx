import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentDto } from '../api';
import { TicketAttachments } from './TicketAttachments';

function renderWithClient(ticketId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TicketAttachments ticketId={ticketId} />
    </QueryClientProvider>,
  );
}

function installFetchMock(
  initialAttachments: AttachmentDto[],
  options: { readonly deleteResponse?: 'ok' | 'error' } = {},
): ReturnType<typeof vi.fn> {
  let attachments = initialAttachments;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/tickets/bdboard-1/attachments' && (init === undefined || init.method === undefined)) {
      return new Response(JSON.stringify({ attachments }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const deleteMatch = /^\/api\/tickets\/bdboard-1\/attachments\/(.+)$/.exec(url);
    if (deleteMatch !== null && init?.method === 'DELETE') {
      const [, fileName] = deleteMatch;
      if (options.deleteResponse === 'error') {
        return new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      attachments = attachments.filter((a) => a.fileName !== decodeURIComponent(fileName ?? ''));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(init)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function makeAttachment(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    fileName: '1758300000000-0123456789abcdef.png',
    url: '/api/tickets/bdboard-1/attachments/1758300000000-0123456789abcdef.png',
    byteLength: 2048,
    createdAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('TicketAttachments', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('renders nothing when there are no attachments', async () => {
    installFetchMock([]);
    const { container } = renderWithClient('bdboard-1');

    await waitFor(() => expect(container.querySelector('.detail-section')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('renders a thumbnail per attachment and hides the lightbox by default', async () => {
    installFetchMock([makeAttachment(), makeAttachment({ fileName: 'b.png', url: '/api/tickets/bdboard-1/attachments/b.png' })]);
    renderWithClient('bdboard-1');

    await waitFor(() => expect(screen.getAllByAltText('添付画像のサムネイル')).toHaveLength(2));
    expect(screen.queryByAltText('添付画像の拡大表示')).toBeNull();
  });

  it('shows a delete button in the lightbox that requires a second confirm click before deleting', async () => {
    const user = userEvent.setup();
    installFetchMock([makeAttachment()], { deleteResponse: 'ok' });
    renderWithClient('bdboard-1');

    const thumbnailButton = await screen.findByRole('button', { name: '添付画像のサムネイル' });
    await user.click(thumbnailButton);
    await screen.findByAltText('添付画像の拡大表示');

    await user.click(screen.getByRole('button', { name: '削除' }));
    // Two-step confirm: clicking once must not delete yet.
    expect(screen.queryByRole('button', { name: '削除' })).toBeNull();
    expect(screen.getByRole('button', { name: '確定: 削除' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.getByRole('button', { name: '削除' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '確定: 削除' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '削除' }));
    await user.click(screen.getByRole('button', { name: '確定: 削除' }));

    await waitFor(() => expect(screen.queryByAltText('添付画像の拡大表示')).toBeNull());
  });

  it('re-fetches the attachment list and closes the lightbox after a successful delete', async () => {
    const user = userEvent.setup();
    const fetchMock = installFetchMock([makeAttachment()], { deleteResponse: 'ok' });
    renderWithClient('bdboard-1');

    const thumbnailButton = await screen.findByRole('button', { name: '添付画像のサムネイル' });
    await user.click(thumbnailButton);
    await screen.findByAltText('添付画像の拡大表示');

    await user.click(screen.getByRole('button', { name: '削除' }));
    await user.click(screen.getByRole('button', { name: '確定: 削除' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/tickets/bdboard-1/attachments/1758300000000-0123456789abcdef.png',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    await waitFor(() => expect(screen.queryByAltText('添付画像の拡大表示')).toBeNull());
    // The section disappears entirely once the underlying list is empty.
    await waitFor(() => expect(screen.queryByText('添付画像')).toBeNull());
  });

  it('shows an error message and keeps the lightbox open when the delete request fails', async () => {
    const user = userEvent.setup();
    installFetchMock([makeAttachment()], { deleteResponse: 'error' });
    renderWithClient('bdboard-1');

    const thumbnailButton = await screen.findByRole('button', { name: '添付画像のサムネイル' });
    await user.click(thumbnailButton);
    await screen.findByAltText('添付画像の拡大表示');

    await user.click(screen.getByRole('button', { name: '削除' }));
    await user.click(screen.getByRole('button', { name: '確定: 削除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('削除に失敗しました');
    expect(screen.getByAltText('添付画像の拡大表示')).toBeInTheDocument();
  });

  it('opens a lightbox with the full-size image and byte size on thumbnail click, and closes it', async () => {
    const user = userEvent.setup();
    installFetchMock([makeAttachment({ byteLength: 3 * 1024 })]);
    renderWithClient('bdboard-1');

    const thumbnailButton = await screen.findByRole('button', { name: '添付画像のサムネイル' });
    await user.click(thumbnailButton);

    expect(await screen.findByAltText('添付画像の拡大表示')).toHaveAttribute(
      'src',
      '/api/tickets/bdboard-1/attachments/1758300000000-0123456789abcdef.png',
    );
    expect(screen.getByText('3.0 KB')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(screen.queryByAltText('添付画像の拡大表示')).toBeNull());
  });
});
