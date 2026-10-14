import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localFileRawUrl, type LocalFileListEntryDto } from '../../api/local-files';
import { buildLocalFileViewerUrl, type LocalFileViewerRoute } from '../../localFileViewerRoute';
import { LocalFileViewerPage } from './LocalFileViewerPage';

const TICKET_ID = 'video-p4q.38';
const DIR = 'out/13-demo/stills';
const LIST_URL = `/api/tickets/${encodeURIComponent(TICKET_ID)}/local-files/list?path=${encodeURIComponent(DIR)}`;

function imageEntry(name: string, size: number): LocalFileListEntryDto {
  return { name, path: `${DIR}/${name}`, kind: 'image', size };
}

const S01 = imageEntry('s01.png', 1024);
const S02 = imageEntry('s02.png', 2048);
const S03 = imageEntry('s03.png', 3072);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage(route: LocalFileViewerRoute, hostname = 'localhost') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalFileViewerPage route={route} hostname={hostname} />
    </QueryClientProvider>,
  );
}

function installList(entries: readonly LocalFileListEntryDto[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== LIST_URL) throw new Error(`Unexpected fetch: ${url}`);
    return jsonResponse({ path: DIR, truncated: false, entries });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LocalFileViewerPage', () => {
  afterEach(() => {
    document.title = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a local-only notice and does not fetch off loopback', async () => {
    const fetchMock = installList([S02]);
    renderPage(
      { ticketId: TICKET_ID, path: S02.path, kind: 'image', size: S02.size ?? undefined },
      'example.trycloudflare.com',
    );

    expect(screen.getByText('このビューアはローカルで開いたときだけ使えます。')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it('shows an image, its path, its size, and the file name in the title', async () => {
    installList([S01, S02, S03]);
    renderPage({ ticketId: TICKET_ID, path: S02.path, kind: 'image', size: 2048 });

    const image = await screen.findByRole('img', { name: 's02.png' });
    expect(image).toHaveAttribute('src', localFileRawUrl(TICKET_ID, S02.path));
    expect(screen.getByText(S02.path)).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toContain('s02.png'));
  });

  it('moves to the next image in the same folder and updates the viewer url', async () => {
    const user = userEvent.setup();
    const replaceState = vi.spyOn(window.history, 'replaceState');
    installList([S01, S02, S03]);
    renderPage({ ticketId: TICKET_ID, path: S02.path, kind: 'image', size: 2048 });

    expect(await screen.findByText('2 / 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '次へ' }));

    const image = await screen.findByRole('img', { name: 's03.png' });
    expect(image).toHaveAttribute('src', localFileRawUrl(TICKET_ID, S03.path));
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      buildLocalFileViewerUrl({
        ticketId: TICKET_ID,
        path: S03.path,
        kind: 'image',
        size: S03.size,
      }),
    );
  });

  it('renders a video element and an audio element with the raw url', () => {
    const videoPath = 'out/13-demo/reading-review.mp4';
    const { container, unmount } = renderPage({
      ticketId: TICKET_ID,
      path: videoPath,
      kind: 'video',
      size: 4096,
    });
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', localFileRawUrl(TICKET_ID, videoPath));
    expect(video).toHaveAttribute('controls');

    unmount();
    const audioPath = 'out/13-demo/reading.m4a';
    const audioView = renderPage({ ticketId: TICKET_ID, path: audioPath, kind: 'audio', size: 512 });
    const audio = audioView.container.querySelector('audio');
    expect(audio).toHaveAttribute('src', localFileRawUrl(TICKET_ID, audioPath));
    expect(audio).toHaveAttribute('controls');
  });

  it('shows fetched text in a pre element', async () => {
    const path = 'channel/uploads/13-demo/notes.txt';
    const rawUrl = localFileRawUrl(TICKET_ID, path);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe(rawUrl);
        return new Response('scene one', { status: 200 });
      }),
    );
    renderPage({ ticketId: TICKET_ID, path, kind: 'text', size: 9 });

    const pre = await screen.findByText('scene one');
    expect(pre.tagName).toBe('PRE');
  });

  it('renders markdown as a heading', async () => {
    const path = 'projects/demo/script/review.md';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('# 見出し\n', { status: 200 })),
    );
    renderPage({ ticketId: TICKET_ID, path, kind: 'markdown' });
    expect(await screen.findByRole('heading', { name: '見出し' })).toBeInTheDocument();
  });

  it('renders json as collapsible details', async () => {
    const path = 'projects/demo/thumbnail.json';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"title":"demo"}', { status: 200 })),
    );
    renderPage({ ticketId: TICKET_ID, path, kind: 'json' });
    expect((await screen.findAllByRole('group')).length).toBeGreaterThan(0);
    expect(screen.getByText('title')).toBeInTheDocument();
  });

  it('opens a chosen thumbnail in the same window', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    installList([S01, S02]);
    renderPage({ ticketId: TICKET_ID, path: DIR, kind: 'directory' });

    expect(await screen.findByRole('img', { name: 's01.png' })).toHaveClass('attachment-thumbnail-image');
    expect(document.querySelector('img.local-file-viewer-image')).toBeNull();
    await user.click(screen.getByRole('img', { name: 's01.png' }));

    const large = await screen.findByRole('img', { name: 's01.png' });
    expect(large).toHaveClass('local-file-viewer-image');
    expect(large).toHaveAttribute('src', localFileRawUrl(TICKET_ID, S01.path));
    expect(openSpy).not.toHaveBeenCalled();
  });
});
