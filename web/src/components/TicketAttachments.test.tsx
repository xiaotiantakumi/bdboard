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

function installFetchMock(attachments: AttachmentDto[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/tickets/bdboard-1/attachments') {
      return new Response(JSON.stringify({ attachments }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
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
