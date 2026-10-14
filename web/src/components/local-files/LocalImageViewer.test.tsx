import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalFileListEntryDto } from '../../api/local-files';
import { localFileRawUrl } from '../../api/local-files';
import { LocalImageViewer } from './LocalImageViewer';

const TICKET_ID = 'video-p4q.38';
const DIR = 'out/13-demo/stills';
const S01: LocalFileListEntryDto = {
  name: 's01.png',
  path: `${DIR}/s01.png`,
  kind: 'image',
  size: 10,
};
const S02: LocalFileListEntryDto = {
  name: 's02.png',
  path: `${DIR}/s02.png`,
  kind: 'image',
  size: 20,
};
const NOTES: LocalFileListEntryDto = {
  name: 'notes.md',
  path: `${DIR}/notes.md`,
  kind: 'markdown',
  size: 30,
};
const S10: LocalFileListEntryDto = {
  name: 's10.png',
  path: `${DIR}/s10.png`,
  kind: 'image',
  size: 40,
};
const LIST_URL = `/api/tickets/${encodeURIComponent(TICKET_ID)}/local-files/list?path=${encodeURIComponent(DIR)}`;

function renderViewer(path: string, onNavigate = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <LocalImageViewer ticketId={TICKET_ID} path={path} onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
  return { ...view, onNavigate };
}

function installListFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== LIST_URL) throw new Error(`Unexpected fetch: ${url}`);
    return new Response(
      JSON.stringify({
        path: DIR,
        truncated: false,
        entries: [S01, S02, NOTES, S10],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LocalImageViewer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('points the image src at the raw url', async () => {
    installListFetch();
    renderViewer(S02.path);

    const image = await screen.findByRole('img', { name: 's02.png' });
    expect(image).toHaveAttribute('src', localFileRawUrl(TICKET_ID, S02.path));
    expect(image).toHaveClass('local-file-viewer-image');
  });

  it('steps through image siblings and ignores non-images', async () => {
    const user = userEvent.setup();
    installListFetch();
    const { onNavigate } = renderViewer(S02.path);

    expect(await screen.findByText('2 / 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(onNavigate).toHaveBeenCalledWith(S10);

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onNavigate).toHaveBeenCalledWith(S01);
  });

  it('disables the previous button on the first image', async () => {
    installListFetch();
    renderViewer(S01.path);

    expect(await screen.findByText('1 / 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前へ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '次へ' })).toBeEnabled();
  });

  it('does not fetch a directory listing for a file at the project root', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('list should not be fetched');
    });
    vi.stubGlobal('fetch', fetchMock);
    renderViewer('thumbnail.png');

    const image = screen.getByRole('img', { name: 'thumbnail.png' });
    expect(image).toHaveAttribute('src', localFileRawUrl(TICKET_ID, 'thumbnail.png'));
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '前へ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '次へ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'フォルダの一覧へ' })).not.toBeInTheDocument();
  });

  it('leaves modifier + arrow chords to the browser', async () => {
    installListFetch();
    const { onNavigate } = renderViewer(S02.path);

    expect(await screen.findByText('2 / 3')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'ArrowRight', metaKey: true });
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onNavigate).toHaveBeenCalledWith(S10);
  });

  it('goes back to the folder grid from the folder button', async () => {
    const user = userEvent.setup();
    installListFetch();
    const { onNavigate } = renderViewer(S02.path);

    await user.click(await screen.findByRole('button', { name: 'フォルダの一覧へ' }));
    expect(onNavigate).toHaveBeenCalledWith({
      name: 'stills',
      path: DIR,
      kind: 'directory',
      size: null,
    });
  });
});
