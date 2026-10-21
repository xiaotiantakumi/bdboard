import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalFileListDto, LocalFileRefDto } from '../../api/local-files';
import { localFileRawUrl } from '../../api/local-files';
import { TicketLocalFilesSection } from './TicketLocalFilesSection';

const TICKET_ID = 'video-p4q.38';
const FILES_URL = `/api/tickets/${encodeURIComponent(TICKET_ID)}/local-files`;
const STILLS = 'out/13-demo/stills';
const STILL_PATH = 'out/13-demo/stills/s01.png';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TicketLocalFilesSection ticketId={TICKET_ID} />
    </QueryClientProvider>,
  );
}

function installFetch(files: readonly LocalFileRefDto[], list?: LocalFileListDto) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === FILES_URL) return jsonResponse({ files });
    if (list !== undefined && url === `${FILES_URL}/list?path=${encodeURIComponent(STILLS)}`) {
      return jsonResponse(list);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('TicketLocalFilesSection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('shows kind, path, and size for files when opened on localhost', async () => {
    installFetch([
      { path: 'projects/demo/script/scenes.json', kind: 'json', size: 512 },
      { path: 'projects/demo/script/review.md', kind: 'markdown', size: 2048 },
    ]);
    renderSection();

    expect(await screen.findByRole('heading', { name: 'ファイル' })).toBeInTheDocument();
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('projects/demo/script/scenes.json')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('projects/demo/script/review.md')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('lists the files on a tunnel host too (the server guard decides)', async () => {
    vi.stubGlobal('location', { ...window.location, hostname: 'example.trycloudflare.com' });
    installFetch([{ path: 'projects/demo/thumbnail.json', kind: 'json', size: 10 }]);
    renderSection();

    expect(await screen.findByRole('heading', { name: 'ファイル' })).toBeInTheDocument();
    expect(screen.getByText('projects/demo/thumbnail.json')).toBeInTheDocument();
  });

  it('renders nothing when the server denies the session (403)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'local access only' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container } = renderSection();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the ticket has no local files', async () => {
    const fetchMock = installFetch([]);
    const { container } = renderSection();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(FILES_URL, undefined));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('heading', { name: 'ファイル' })).not.toBeInTheDocument();
  });

  it('opens the viewer URL in a new window when a file row is clicked', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    installFetch([
      { path: 'projects/demo/script/scenes.json', kind: 'json', size: 512 },
    ]);
    renderSection();

    await user.click(await screen.findByRole('button', { name: /scenes\.json/ }));
    expect(
      screen.getByRole('button', { name: 'JSON、projects/demo/script/scenes.json、512 B（新しいウィンドウで開く）' }),
    ).toBeInTheDocument();

    expect(openSpy).toHaveBeenCalledWith(
      '/?view=local-file&ticket=video-p4q.38&path=projects%2Fdemo%2Fscript%2Fscenes.json&kind=json&size=512',
      '_blank',
      'noopener',
    );
  });

  it('lists folder images and opens the clicked thumbnail in the viewer', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const fetchMock = installFetch(
      [{ path: STILLS, kind: 'directory', size: null }],
      {
        path: STILLS,
        truncated: true,
        entries: [
          { name: 's01.png', path: STILL_PATH, kind: 'image', size: 100 },
          { name: 's02.png', path: 'out/13-demo/stills/s02.png', kind: 'image', size: 200 },
        ],
      },
    );
    renderSection();

    const folder = await screen.findByRole('button', { name: /stills/ });
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    expect(folder).not.toHaveAttribute('aria-controls');
    await user.click(folder);

    expect(folder).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${FILES_URL}/list?path=${encodeURIComponent(STILLS)}`,
        undefined,
      ),
    );
    const thumbs = await screen.findAllByRole('img');
    const region = document.getElementById(folder.getAttribute('aria-controls') ?? '');
    expect(region).not.toBeNull();
    expect(region).toContainElement(thumbs[0]!);
    expect(thumbs).toHaveLength(2);
    expect(thumbs[0]).toHaveAttribute('src', localFileRawUrl(TICKET_ID, STILL_PATH));
    expect(thumbs[0]).toHaveAttribute('loading', 'lazy');
    expect(screen.getByText('先頭の一部だけ表示しています。')).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();

    await user.click(thumbs[0]!);

    expect(openSpy).toHaveBeenCalledWith(
      '/?view=local-file&ticket=video-p4q.38&path=out%2F13-demo%2Fstills%2Fs01.png&kind=image&size=100',
      '_blank',
      'noopener',
    );
  });
});
