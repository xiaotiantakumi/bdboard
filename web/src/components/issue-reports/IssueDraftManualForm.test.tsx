import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { IssueDraftImageUploadResponseDto, IssueDraftSummaryDto } from '../../api/issue-reports';
import { expectNoA11yViolations } from '../../test/axe';
import { stubObjectUrls } from '../../test/objectUrls';
import { IssueDraftManualForm } from './IssueDraftManualForm';
import {
  IMAGE_LIMIT_REACHED_HELP,
  IMAGE_REJECTED_HELP,
  MANUAL_BAD_REQUEST_HELP,
  MANUAL_LOCAL_ONLY_HELP,
  MANUAL_RATE_LIMITED_HELP,
  MANUAL_REQUEST_TOO_LARGE_HELP,
  STORAGE_FULL_HELP,
} from './issueDraftErrors';
import { ISSUE_DRAFT_IMAGE_MAX_BYTES } from './issueDraftImageLimits';
import { IMAGE_NOT_SENT_REASON } from './issueDraftImageUpload';

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

/** localAccess は既定で true (ローカルで開いている)。false はトンネル経由の再現。 */
function setup(project?: { readonly name: string; readonly path: string }, options: { readonly localAccess?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <IssueDraftManualForm
        project={project}
        localAccess={options.localAccess ?? true}
        onCreated={onCreated}
        onCancel={onCancel}
      />
    </QueryClientProvider>,
  );
  return { view, user: userEvent.setup(), invalidate, onCreated, onCancel };
}

async function fillAndSend(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
  await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes when I open the tab');
  await user.click(screen.getByRole('button', { name: '送る' }));
}

let restoreObjectUrls: () => void;

beforeEach(() => {
  vi.mocked(createManualIssueDraft).mockReset();
  vi.mocked(uploadIssueDraftImage).mockReset();
  restoreObjectUrls = stubObjectUrls().restore;
});

afterEach(() => {
  restoreObjectUrls();
});

describe('IssueDraftManualForm (bdboard-4y8q.6.8)', () => {
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

  it('does not create a second draft when the form is submitted again while the first is being sent', async () => {
    vi.mocked(createManualIssueDraft).mockReturnValue(new Promise(() => {}));
    const { user } = setup();
    await fillAndSend(user);
    expect(await screen.findByRole('button', { name: '送信中…' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: '新しく報告' }));
    expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
  });
});

const PRIVACY_NOTE = '画像は手元にだけ保存され、公開 issue には自動では載りません。';

const storedImage: IssueDraftImageUploadResponseDto = {
  image: { fileName: '1-0123456789abcdef.png', url: '/x', byteLength: 1, createdAt: '2026-10-06T00:00:00.000Z' },
};

/** 中身を 1 文字ずつ変えた PNG 扱いの File (送った base64 から、どの画像かが分かる)。 */
function png(name: string, contents = 'x'): File {
  return new File([contents], name, { type: 'image/png' });
}

/** 「画像を選ぶ」で選んだことにする。 */
function chooseImages(files: readonly File[]) {
  fireEvent.change(screen.getByLabelText('画像のファイルを選ぶ'), { target: { files } });
}

async function typeReport(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: /題名/ }), 'Board freezes');
  await user.type(screen.getByRole('textbox', { name: /説明/ }), 'It freezes when I open the tab');
}

const sendButton = () => screen.getByRole('button', { name: '送る' });

/** 送った画像の base64 の並び (呼ばれた順)。 */
function uploadedData(): string[] {
  return vi.mocked(uploadIssueDraftImage).mock.calls.map((call) => call[1].data);
}

describe('IssueDraftManualForm: images (bdboard-4y8q.6.9)', () => {
  describe('the field', () => {
    it('shows the image field with the note that images stay on this machine', () => {
      setup();
      expect(screen.getByRole('group', { name: /画像 \(任意\)/ })).toBeInTheDocument();
      expect(screen.getByText(PRIVACY_NOTE)).toBeInTheDocument();
    });

    it('shows neither the field, the note nor a file input when the board is opened through the tunnel', () => {
      setup(undefined, { localAccess: false });
      expect(screen.queryByRole('group', { name: /画像/ })).toBeNull();
      expect(screen.queryByLabelText('画像のファイルを選ぶ')).toBeNull();
      expect(screen.queryByRole('button', { name: '画像を選ぶ' })).toBeNull();
      expect(screen.queryByText(PRIVACY_NOTE)).toBeNull();
    });

    it('takes an image pasted into the form and stops the browser from pasting it as text', () => {
      setup();
      const prevented = !fireEvent.paste(screen.getByRole('textbox', { name: /説明/ }), {
        clipboardData: { files: [png('paste.png')], types: ['Files'] },
      });
      expect(prevented).toBe(true);
      expect(screen.getByText('paste.png')).toBeInTheDocument();
    });

    it('leaves a text paste to the browser', () => {
      setup();
      const prevented = !fireEvent.paste(screen.getByRole('textbox', { name: /説明/ }), {
        clipboardData: { files: [], types: ['text/plain'] },
      });
      expect(prevented).toBe(false);
      expect(screen.queryByRole('list', { name: '付ける画像' })).toBeNull();
    });

    it('ignores a pasted image through the tunnel (no field to show it in, and the paste is left to the browser)', () => {
      setup(undefined, { localAccess: false });
      const prevented = !fireEvent.paste(screen.getByRole('textbox', { name: /説明/ }), {
        clipboardData: { files: [png('paste.png')], types: ['Files'] },
      });
      expect(prevented).toBe(false);
      expect(screen.queryByText('paste.png')).toBeNull();
    });

    it('lists the images with the count and takes one off again before sending', async () => {
      const { user } = setup();
      chooseImages([png('a.png'), png('b.png')]);
      expect(screen.getByRole('group', { name: '画像 (任意) 2 / 20' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '「a.png」を外す' }));
      expect(screen.queryByText('a.png')).toBeNull();
      expect(screen.getByText('b.png')).toBeInTheDocument();
      expect(screen.getByRole('group', { name: '画像 (任意) 1 / 20' })).toBeInTheDocument();
    });
  });

  describe('screen-side checks', () => {
    it('refuses an image over 10 MiB, naming it and the limit, and does not list it', () => {
      setup();
      chooseImages([new File([new Uint8Array(ISSUE_DRAFT_IMAGE_MAX_BYTES + 1)], 'large.png', { type: 'image/png' })]);
      expect(screen.getByRole('alert')).toHaveTextContent('large.png');
      expect(screen.getByRole('alert')).toHaveTextContent('10 MiB');
      expect(screen.queryByRole('list', { name: '付ける画像' })).toBeNull();
    });

    it('refuses a format the server does not take, and keeps the images that are fine', () => {
      setup();
      chooseImages([png('ok.png'), new File(['x'], 'vector.svg', { type: 'image/svg+xml' })]);
      expect(screen.getByRole('alert')).toHaveTextContent('vector.svg');
      expect(screen.getByRole('alert')).toHaveTextContent('PNG・JPEG・WebP・GIF');
      expect(screen.getByText('ok.png')).toBeInTheDocument();
      expect(screen.queryByText('vector.svg')).toBeNull();
    });

    it('takes 20 images and refuses the 21st, naming it', () => {
      setup();
      chooseImages(Array.from({ length: 21 }, (_, index) => png(`shot-${index + 1}.png`)));
      expect(screen.getByRole('group', { name: '画像 (任意) 20 / 20' })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('画像は 20 枚までです');
      expect(screen.getByRole('alert')).toHaveTextContent('「shot-21.png」');
      expect(screen.queryByText('shot-21.png')).toBeNull();
    });

    it('does not create a draft just because an image was refused', () => {
      setup();
      chooseImages([new File(['x'], 'vector.svg', { type: 'image/svg+xml' })]);
      expect(createManualIssueDraft).not.toHaveBeenCalled();
      expect(uploadIssueDraftImage).not.toHaveBeenCalled();
    });
  });

  describe('sending', () => {
    it('creates the draft first, then sends the images one at a time in the order listed, to the new draft', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockResolvedValue(storedImage);
      const { user } = setup();
      await typeReport(user);
      chooseImages([png('1.png', '1'), png('2.png', '2'), png('3.png', '3')]);
      await user.click(sendButton());
      await waitFor(() => expect(uploadIssueDraftImage).toHaveBeenCalledTimes(3));
      expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createManualIssueDraft).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(uploadIssueDraftImage).mock.invocationCallOrder[0],
      );
      // "1" "2" "3" の base64。
      expect(uploadedData()).toEqual(['MQ==', 'Mg==', 'Mw==']);
      for (const call of vi.mocked(uploadIssueDraftImage).mock.calls) {
        expect(call[0]).toBe(created.id);
        expect(call[1].mimeType).toBe('image/png');
      }
    });

    it('reloads the list after the last image and only then hands the draft to onCreated', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockResolvedValue(storedImage);
      const { user, invalidate, onCreated } = setup();
      await typeReport(user);
      chooseImages([png('1.png'), png('2.png')]);
      await user.click(sendButton());
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['issue-reports'] });
      expect(vi.mocked(uploadIssueDraftImage).mock.invocationCallOrder[1]).toBeLessThan(
        invalidate.mock.invocationCallOrder[0],
      );
      expect(onCreated).toHaveBeenCalledTimes(1);
    });

    it('does not send an image that was taken off before sending', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockResolvedValue(storedImage);
      const { user, onCreated } = setup();
      await typeReport(user);
      chooseImages([png('a.png', 'a'), png('b.png', 'b')]);
      await user.click(screen.getByRole('button', { name: '「a.png」を外す' }));
      await user.click(sendButton());
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(uploadedData()).toEqual(['Yg==']);
    });

    it('sends no image request when there is no image', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      const { user, onCreated } = setup();
      await fillAndSend(user);
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
      expect(uploadIssueDraftImage).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('sends no image request through the tunnel', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      const { user, onCreated } = setup(undefined, { localAccess: false });
      await fillAndSend(user);
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
      expect(uploadIssueDraftImage).not.toHaveBeenCalled();
    });

    it('shows how many images are sent, and locks the field, the paste and the buttons meanwhile', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      const releases: Array<() => void> = [];
      vi.mocked(uploadIssueDraftImage).mockImplementation(
        () =>
          new Promise<IssueDraftImageUploadResponseDto>((resolve) => {
            releases.push(() => resolve(storedImage));
          }),
      );
      const { user, onCreated } = setup();
      await typeReport(user);
      chooseImages([png('a.png'), png('b.png')]);
      await user.click(sendButton());

      expect(await screen.findByRole('status')).toHaveTextContent('画像を送っています (0 / 2)');
      expect(screen.getByRole('button', { name: '送信中…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'やめる' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '画像を選ぶ' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '「a.png」を外す' })).toBeDisabled();
      // 送っている間の貼り付けは受けない。
      fireEvent.paste(screen.getByRole('textbox', { name: /説明/ }), {
        clipboardData: { files: [png('late.png')], types: ['Files'] },
      });
      expect(screen.queryByText('late.png')).toBeNull();

      await waitFor(() => expect(releases).toHaveLength(1));
      releases[0]?.();
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('画像を送っています (1 / 2)'));
      await waitFor(() => expect(releases).toHaveLength(2));
      releases[1]?.();
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    });

    it('keeps the input and the images, and sends no image, when the draft could not be created; sending again then works', async () => {
      vi.mocked(createManualIssueDraft).mockRejectedValueOnce(apiError(429, { error: 'x', code: 'manual-rate-limited' }));
      vi.mocked(createManualIssueDraft).mockResolvedValueOnce({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockResolvedValue(storedImage);
      const { user, onCreated } = setup();
      await typeReport(user);
      chooseImages([png('a.png', 'a')]);
      await user.click(sendButton());
      expect(await screen.findByRole('alert')).toHaveTextContent(MANUAL_RATE_LIMITED_HELP);
      expect(uploadIssueDraftImage).not.toHaveBeenCalled();
      expect(screen.getByText('a.png')).toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /題名/ })).toHaveValue('Board freezes');

      await user.click(sendButton());
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
      expect(createManualIssueDraft).toHaveBeenCalledTimes(2);
      expect(uploadedData()).toEqual(['YQ==']);
    });
  });

  describe('when some images do not attach', () => {
    async function sendWithTwoImages(user: ReturnType<typeof userEvent.setup>) {
      await typeReport(user);
      chooseImages([png('first.png', 'a'), png('second.png', 'b')]);
      await user.click(sendButton());
    }

    it('keeps the created draft, names the image that failed with the reason, and does not open the draft by itself', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage)
        .mockResolvedValueOnce(storedImage)
        .mockRejectedValueOnce(apiError(400, { error: 'invalid or unsupported image data' }));
      const { user, invalidate, onCreated } = setup();
      await sendWithTwoImages(user);

      expect(await screen.findByRole('heading', { name: '下書きを作りました' })).toHaveFocus();
      expect(screen.getByRole('alert')).toHaveTextContent('下書きは作れましたが、次の画像は付けられませんでした。');
      const items = screen.getAllByRole('listitem');
      expect(items).toHaveLength(1);
      expect(items[0]).toHaveTextContent(`2 枚目「second.png」: ${IMAGE_REJECTED_HELP}`);
      // 作った下書きは一覧に出ているが、利用者が選ぶまで開かない。
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['issue-reports'] });
      expect(onCreated).not.toHaveBeenCalled();
    });

    it('does not show the form again, so the report cannot be sent twice', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockRejectedValue(apiError(400, { error: 'invalid or unsupported image data' }));
      const { user } = setup();
      await sendWithTwoImages(user);
      await screen.findByRole('heading', { name: '下書きを作りました' });
      expect(screen.queryByRole('button', { name: '送る' })).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
    });

    it('sends again only the images that did not attach, to the same draft, and then opens the draft', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage)
        .mockResolvedValueOnce(storedImage)
        .mockRejectedValueOnce(apiError(400, { error: 'invalid or unsupported image data' }))
        .mockResolvedValueOnce(storedImage);
      const { user, onCreated } = setup();
      await sendWithTwoImages(user);
      await user.click(await screen.findByRole('button', { name: '付かなかった画像をもう一度送る' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
      // 1 回目は a と b、やり直しは b だけ。
      expect(uploadedData()).toEqual(['YQ==', 'Yg==', 'Yg==']);
      expect(vi.mocked(uploadIssueDraftImage).mock.calls.map((call) => call[0])).toEqual([created.id, created.id, created.id]);
      expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
    });

    it('stays on the result when the retry fails again, and still lets the user open the draft', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage)
        .mockResolvedValueOnce(storedImage)
        .mockRejectedValueOnce(apiError(400, { error: 'invalid or unsupported image data' }))
        .mockRejectedValueOnce(apiError(413, { error: 'request body too large' }));
      const { user, onCreated } = setup();
      await sendWithTwoImages(user);
      await user.click(await screen.findByRole('button', { name: '付かなかった画像をもう一度送る' }));
      await waitFor(() => expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('画像が大きすぎます'));
      expect(onCreated).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: '下書きを作りました' })).toHaveFocus();

      await user.click(screen.getByRole('button', { name: '下書きを開く' }));
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith(created);
      expect(createManualIssueDraft).toHaveBeenCalledTimes(1);
    });

    it('opens the draft from the result without sending anything more', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockRejectedValue(apiError(400, { error: 'invalid or unsupported image data' }));
      const { user, onCreated } = setup();
      await sendWithTwoImages(user);
      await user.click(await screen.findByRole('button', { name: '下書きを開く' }));
      expect(onCreated).toHaveBeenCalledWith(created);
      expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2);
    });

    it('tells images of the same name apart by their position', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage)
        .mockResolvedValueOnce(storedImage)
        .mockRejectedValueOnce(apiError(400, { error: 'invalid or unsupported image data' }));
      const { user } = setup();
      await typeReport(user);
      chooseImages([png('image.png', 'a'), png('image.png', 'b')]);
      await user.click(sendButton());
      expect(await screen.findByText('2 枚目「image.png」')).toBeInTheDocument();
    });

    it('stops at a 409 limit-reached and says the rest were not sent', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(apiError(409, { error: 'image limit reached (max 20 per draft)' }));
      const { user } = setup();
      await sendWithTwoImages(user);
      await screen.findByRole('heading', { name: '下書きを作りました' });
      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent(`1 枚目「first.png」: ${IMAGE_LIMIT_REACHED_HELP}`);
      expect(items[1]).toHaveTextContent(`2 枚目「second.png」: ${IMAGE_NOT_SENT_REASON}`);
      expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);
    });

    it('stops at a 507 storage-full and says the rest were not sent', async () => {
      vi.mocked(createManualIssueDraft).mockResolvedValue({ outcome: 'created', draft: created });
      vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(apiError(507, { error: 'issue draft storage is full', code: 'storage-full' }));
      const { user } = setup();
      await sendWithTwoImages(user);
      await screen.findByRole('heading', { name: '下書きを作りました' });
      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent(`1 枚目「first.png」: ${STORAGE_FULL_HELP}`);
      expect(items[1]).toHaveTextContent(`2 枚目「second.png」: ${IMAGE_NOT_SENT_REASON}`);
      expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);
    });
  });

  it('has no accessibility violations with images attached', async () => {
    const { view } = setup();
    chooseImages([png('a.png'), png('b.png')]);
    await expectNoA11yViolations(view.container);
  });
});
