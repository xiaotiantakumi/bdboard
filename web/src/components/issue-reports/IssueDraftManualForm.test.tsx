import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { IssueDraftSummaryDto } from '../../api/issue-reports';
import { IssueDraftManualForm } from './IssueDraftManualForm';
import {
  MANUAL_BAD_REQUEST_HELP,
  MANUAL_LOCAL_ONLY_HELP,
  MANUAL_RATE_LIMITED_HELP,
  MANUAL_REQUEST_TOO_LARGE_HELP,
  STORAGE_FULL_HELP,
} from './issueDraftErrors';

vi.mock('../../api/issue-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/issue-reports')>();
  return { ...actual, createManualIssueDraft: vi.fn(), uploadIssueDraftImage: vi.fn() };
});

import { createManualIssueDraft, uploadIssueDraftImage } from '../../api/issue-reports';

const created: IssueDraftSummaryDto = {
  id: '1758812345678-a1b2c3d4e5f6a7b8',
  kind: 'C',
  fingerprint: 'C:manual:0123456789abcdef',
  title: 'Board freezes on example-project',
  status: 'pending',
  occurrenceCount: 1,
  firstOccurredAt: '2026-10-06T00:00:00.000Z',
  lastOccurredAt: '2026-10-06T00:00:00.000Z',
  occurredProjectCount: 0,
};

function apiError(status: number, payload: Record<string, unknown>): ApiError {
  return new ApiError(status, String(payload.error), {
    body: JSON.stringify(payload),
    errorMessage: String(payload.error),
    code: typeof payload.code === 'string' ? payload.code : undefined,
  });
}

function setup(project?: { readonly name: string; readonly path: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <IssueDraftManualForm project={project} localAccess onCreated={onCreated} onCancel={onCancel} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), invalidate, onCreated, onCancel };
}

async function fillAndSend(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
  await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes when I open the tab');
  await user.click(screen.getByRole('button', { name: '送る' }));
}

describe('IssueDraftManualForm (bdboard-4y8q.6.8)', () => {
  beforeEach(() => {
    vi.mocked(createManualIssueDraft).mockReset();
    vi.mocked(uploadIssueDraftImage).mockReset();
  });

  it('posts the title and description as typed (not trimmed) with no project key when none is given', async () => {
    vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
    const { user } = setup();
    await user.type(screen.getByRole('textbox', { name: /題名/ }), '  title  ');
    await user.type(screen.getByRole('textbox', { name: /説明/ }), ' line1\nline2 ');
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
    expect(createManualIssueDraft).toHaveBeenCalledWith({ title: '  title  ', description: ' line1\nline2 ' });
  });

  it('sends the board project as { name, path } when one is given', async () => {
    vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
    const { user } = setup({ name: 'example-project', path: '/Users/example-user/work/example-project' });
    await fillAndSend(user);
    expect(createManualIssueDraft).toHaveBeenCalledWith({
      title: 'Board freezes',
      description: 'It freezes when I open the tab',
      project: { name: 'example-project', path: '/Users/example-user/work/example-project' },
    });
  });

  it('waits for the issue-reports reload to finish before handing the new draft to onCreated', async () => {
    vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
    const { user, invalidate, onCreated } = setup();
    // 読み直しが終わる前に選ぶと、一覧にまだ無い下書きを選ぶことになる。読み直しを止めておき、終わるまで onCreated が呼ばれないことを見る。
    let finishReload: () => void = () => {};
    invalidate.mockImplementation(
      () =>
        new Promise<void>((done) => {
          finishReload = done;
        }),
    );
    await fillAndSend(user);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['issue-reports'] }));
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '送信中…' })).toBeDisabled();
    finishReload();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  it('moves the focus to the title when the form opens', () => {
    setup();
    expect(screen.getByRole('textbox', { name: /題名/ })).toHaveFocus();
  });

  it('ties the hints to the fields they explain', () => {
    setup({ name: 'example-project', path: '/Users/example-user/work/example-project' });
    expect(screen.getByRole('textbox', { name: /説明/ })).toHaveAccessibleDescription(/公開される本文にはまだ入りません/);
    expect(screen.getByRole('textbox', { name: /題名/ })).toHaveAccessibleDescription(/対象プロジェクト: example-project/);
  });

  it.each([
    ['429 manual-rate-limited', apiError(429, { error: 'too many manual reports in the last hour', code: 'manual-rate-limited' }), MANUAL_RATE_LIMITED_HELP],
    ['507 storage-full', apiError(507, { error: 'issue draft storage is full', code: 'storage-full' }), STORAGE_FULL_HELP],
    ['403 local access only', apiError(403, { error: 'local access only' }), MANUAL_LOCAL_ONLY_HELP],
    ['413 request body too large', apiError(413, { error: 'request body too large' }), MANUAL_REQUEST_TOO_LARGE_HELP],
    ['400 invalid request body', apiError(400, { error: 'invalid request body' }), MANUAL_BAD_REQUEST_HELP],
  ])('shows the reason for %s, keeps the input and does not create', async (_name, error, expected) => {
    vi.mocked(createManualIssueDraft).mockRejectedValue(error);
    const { user, onCreated } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(screen.getByRole('textbox', { name: /題名/ })).toHaveValue('Board freezes');
    expect(screen.getByRole('textbox', { name: /説明/ })).toHaveValue('It freezes when I open the tab');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '送る' })).toBeEnabled();
  });

  it('says the rate limit is per hour (not the generic "usage limit" text)', async () => {
    vi.mocked(createManualIssueDraft).mockRejectedValue(apiError(429, { error: 'x', code: 'manual-rate-limited' }));
    const { user } = setup();
    await fillAndSend(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 時間あたりの上限');
    expect(alert).not.toHaveTextContent('利用上限に達しました');
  });

  it('refuses locally, without calling the API, when a field is blank or too long', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(screen.getByRole('alert')).toHaveTextContent('題名を書いてください');
    await user.type(screen.getByRole('textbox', { name: /題名/ }), 'T');
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(screen.getByRole('alert')).toHaveTextContent('説明を書いてください');
    fireEvent.change(screen.getByRole('textbox', { name: /説明/ }), { target: { value: 'd'.repeat(8001) } });
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(screen.getByRole('alert')).toHaveTextContent('題名は 256 文字、説明は 8000 文字までです');
    fireEvent.change(screen.getByRole('textbox', { name: /説明/ }), { target: { value: 'ok' } });
    fireEvent.change(screen.getByRole('textbox', { name: /題名/ }), { target: { value: 't'.repeat(257) } });
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(screen.getByRole('alert')).toHaveTextContent('長すぎて送れません');
    expect(createManualIssueDraft).not.toHaveBeenCalled();
  });

  it('disables send and cancel while sending', async () => {
    let resolve: (value: { outcome: 'created'; draft: IssueDraftSummaryDto }) => void = () => {};
    vi.mocked(createManualIssueDraft).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { user, onCancel } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('button', { name: '送信中…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'やめる' })).toBeDisabled();
    expect(onCancel).not.toHaveBeenCalled();
    resolve({ outcome: 'created', draft: created });
    expect(await screen.findByRole('button', { name: '送る' })).toBeEnabled();
  });

  it('calls onCancel from the cancel button', async () => {
    const { user, onCancel } = setup();
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('explains that the description stays local and the public body is written with "直す"', () => {
    setup();
    expect(screen.getByText(/公開される本文にはまだ入りません/)).toHaveTextContent('「直す」で書けます');
  });

  it('names no project and offers no project picker when none is given', () => {
    setup();
    expect(screen.queryByText(/対象プロジェクト/)).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows the project name that will be sent', () => {
    setup({ name: 'example-project', path: '/Users/example-user/work/example-project' });
    expect(screen.getByText(/対象プロジェクト: example-project/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('hides image controls and the privacy note when local access is false', () => {
    const client = new QueryClient();
    render(<QueryClientProvider client={client}><IssueDraftManualForm localAccess={false} onCreated={vi.fn()} onCancel={vi.fn()} /></QueryClientProvider>);
    expect(screen.queryByRole('group', { name: /画像 \(任意\)/ })).toBeNull();
    expect(screen.queryByLabelText('画像のファイルを選ぶ')).toBeNull();
    expect(screen.queryByText('画像は手元にだけ保存され、公開 issue には自動では載りません。')).toBeNull();
  });

  it('pastes image files from the form and leaves plain text paste to the browser', () => {
    setup();
    const description = screen.getByRole('textbox', { name: /説明/ });
    const image = new File(['x'], 'paste.png', { type: 'image/png' });
    const imagePaste = fireEvent.paste(description, { clipboardData: { files: [image], types: ['Files'] } });
    expect(imagePaste).toBe(false);
    expect(screen.getByText('paste.png')).toBeInTheDocument();
    const textPaste = fireEvent.paste(description, { clipboardData: { files: [], types: ['text/plain'] } });
    expect(textPaste).toBe(true);
  });

  it('rejects oversized or unsupported images without creating a draft', () => {
    setup();
    const input = screen.getByLabelText('画像のファイルを選ぶ');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('large.png');
    expect(screen.getByRole('alert')).toHaveTextContent('10 MiB');
    expect(screen.queryByText('large.png')).toBeNull();
    fireEvent.change(input, { target: { files: [new File(['x'], 'vector.svg', { type: 'image/svg+xml' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('vector.svg');
    expect(createManualIssueDraft).not.toHaveBeenCalled();
  });

  it('creates the draft before uploading images in order and opens only after all uploads finish', async () => {
    vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({ image: { fileName: 'x.png', url: '/x', byteLength: 1, createdAt: 'now' } });
    const { user, invalidate, onCreated } = setup();
    await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
    await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes');
    const input = screen.getByLabelText('画像のファイルを選ぶ');
    fireEvent.change(input, { target: { files: [1, 2, 3].map((number) => new File([String(number)], `${number}.png`, { type: 'image/png' })) } });
    await user.click(screen.getByRole('button', { name: '送る' }));
    await waitFor(() => expect(uploadIssueDraftImage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(createManualIssueDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(uploadIssueDraftImage).mock.invocationCallOrder[0]!);
    expect(vi.mocked(uploadIssueDraftImage).mock.calls.map((call) => call[1].data)).toEqual(['MQ==', 'Mg==', 'Mw==']);
    expect(invalidate.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(uploadIssueDraftImage).mock.invocationCallOrder[2]!);
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it('keeps the completed draft on image failure and retries only the failed image', async () => {
    vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
    vi.mocked(uploadIssueDraftImage)
      .mockResolvedValueOnce({ image: { fileName: 'first.png', url: '/first', byteLength: 1, createdAt: 'now' } })
      .mockRejectedValueOnce(apiError(400, { error: 'invalid image' }))
      .mockResolvedValueOnce({ image: { fileName: 'second.png', url: '/second', byteLength: 1, createdAt: 'now' } });
    const { user, onCreated } = setup();
    await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
    await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes');
    const input = screen.getByLabelText('画像のファイルを選ぶ');
    fireEvent.change(input, { target: { files: ['first.png', 'second.png'].map((name) => new File(['x'], name, { type: 'image/png' })) } });
    await user.click(screen.getByRole('button', { name: '送る' }));
    expect(await screen.findByRole('heading', { name: '下書きを作りました' })).toHaveFocus();
    expect(screen.getByText(/2 枚目「second\.png」/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '送る' })).toBeNull();
    expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '付かなかった画像をもう一度送る' }));
    await waitFor(() => expect(uploadIssueDraftImage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(uploadIssueDraftImage).mock.calls.map((call) => call[1].data)).toEqual(['eA==', 'eA==', 'eA==']);
    expect(onCreated).toHaveBeenCalledWith(created);
  });
});
