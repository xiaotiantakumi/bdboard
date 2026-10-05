import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import type { IssueDraftImageUploadResponseDto } from '../../api/issue-reports';
import {
  IMAGE_LIMIT_REACHED_HELP,
  IMAGE_REJECTED_HELP,
  IMAGE_TOO_LARGE_HELP,
  STORAGE_FULL_HELP,
} from './issueDraftErrors';
import { IMAGE_NOT_SENT_REASON, IMAGE_READ_FAILED_REASON, uploadIssueDraftImages } from './issueDraftImageUpload';

vi.mock('../../api/issue-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/issue-reports')>();
  return { ...actual, uploadIssueDraftImage: vi.fn() };
});

import { uploadIssueDraftImage } from '../../api/issue-reports';

const DRAFT_ID = '1758812345678-a1b2c3d4e5f6a7b8';

const stored: IssueDraftImageUploadResponseDto = {
  image: { fileName: '1-0123456789abcdef.png', url: '/x', byteLength: 3, createdAt: '2026-10-06T00:00:00.000Z' },
};

function picked(name: string, contents = 'abc') {
  return { id: `id-${name}`, name, file: new File([contents], name, { type: 'image/png' }) };
}

function apiError(status: number, options: { code?: string; errorMessage?: string; body?: unknown } = {}): ApiError {
  return new ApiError(status, `HTTP ${status}`, {
    code: options.code,
    errorMessage: options.errorMessage,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe('uploadIssueDraftImages (bdboard-4y8q.6.9)', () => {
  beforeEach(() => {
    vi.mocked(uploadIssueDraftImage).mockReset();
  });

  it('sends the images to the given draft with the MIME type of the file and only the base64 (no data URL prefix)', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValue(stored);
    await uploadIssueDraftImages(DRAFT_ID, [picked('a.png', 'abc')]);
    // "abc" の base64 は YWJj。
    expect(uploadIssueDraftImage).toHaveBeenCalledWith(DRAFT_ID, { mimeType: 'image/png', data: 'YWJj' });
  });

  it('returns no failures when every image is stored', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValue(stored);
    await expect(uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png')])).resolves.toEqual([]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2);
  });

  it('sends one image at a time: the next upload starts only after the previous one is answered', async () => {
    const releases: Array<() => void> = [];
    vi.mocked(uploadIssueDraftImage).mockImplementation(
      () =>
        new Promise<IssueDraftImageUploadResponseDto>((resolve) => {
          releases.push(() => resolve(stored));
        }),
    );
    const done = uploadIssueDraftImages(DRAFT_ID, [picked('a.png', 'AAA'), picked('b.png', 'BBB'), picked('c.png', 'CCC')]);

    await vi.waitFor(() => expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1));
    // 1 枚目が答えるまで、2 枚目は始まらない (待つ時間を置いても増えない)。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);

    releases[0]?.();
    await vi.waitFor(() => expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2);

    releases[1]?.();
    await vi.waitFor(() => expect(uploadIssueDraftImage).toHaveBeenCalledTimes(3));
    releases[2]?.();
    await expect(done).resolves.toEqual([]);
    // 送った順は、渡した順。
    expect(vi.mocked(uploadIssueDraftImage).mock.calls.map((call) => call[1].data)).toEqual(['QUFB', 'QkJC', 'Q0ND']);
  });

  it('reports progress from 0 to the total, once per image', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValue(stored);
    const onProgress = vi.fn();
    await uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png')], onProgress);
    expect(onProgress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it('names each failed image with the reason and goes on to the next image after a 400 or a 413', async () => {
    vi.mocked(uploadIssueDraftImage)
      .mockRejectedValueOnce(apiError(400, { errorMessage: 'invalid or unsupported image data' }))
      .mockRejectedValueOnce(apiError(413))
      .mockResolvedValueOnce(stored);
    const failures = await uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png'), picked('c.png')]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(3);
    expect(failures).toEqual([
      { id: 'id-a.png', name: 'a.png', reason: IMAGE_REJECTED_HELP },
      { id: 'id-b.png', name: 'b.png', reason: IMAGE_TOO_LARGE_HELP },
    ]);
  });

  it('goes on to the next image after a network failure', async () => {
    vi.mocked(uploadIssueDraftImage)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(stored);
    const failures = await uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png')]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ id: 'id-a.png', name: 'a.png' });
  });

  it('stops at a 409 limit-reached and returns the images it did not send with their own reason', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValueOnce(stored).mockRejectedValueOnce(apiError(409));
    const failures = await uploadIssueDraftImages(DRAFT_ID, [
      picked('a.png'),
      picked('b.png'),
      picked('c.png'),
      picked('d.png'),
    ]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([
      { id: 'id-b.png', name: 'b.png', reason: IMAGE_LIMIT_REACHED_HELP },
      { id: 'id-c.png', name: 'c.png', reason: IMAGE_NOT_SENT_REASON },
      { id: 'id-d.png', name: 'd.png', reason: IMAGE_NOT_SENT_REASON },
    ]);
  });

  it('stops at a 507 storage-full with the storage message', async () => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(apiError(507, { code: 'storage-full' }));
    const failures = await uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png')]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([
      { id: 'id-a.png', name: 'a.png', reason: STORAGE_FULL_HELP },
      { id: 'id-b.png', name: 'b.png', reason: IMAGE_NOT_SENT_REASON },
    ]);
  });

  it.each([
    ['409 draft-not-pending', apiError(409, { code: 'draft-not-pending', body: { status: 'dismissed' } })],
    ['403 local access only', apiError(403, { errorMessage: 'local access only' })],
    ['404 draft not found', apiError(404)],
  ])('stops after %s: the cause is the draft, so the other images would fail the same way', async (_name, error) => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(error);
    const failures = await uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png'), picked('c.png')]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);
    expect(failures.map((failure) => failure.name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(failures.slice(1).map((failure) => failure.reason)).toEqual([IMAGE_NOT_SENT_REASON, IMAGE_NOT_SENT_REASON]);
  });

  it('counts the image that hit a draft-wide failure and the skipped ones in the progress it reports', async () => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(apiError(507, { code: 'storage-full' }));
    const onProgress = vi.fn();
    await uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png')], onProgress);
    expect(onProgress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  describe('when the file cannot be read', () => {
    const original = FileReader.prototype.readAsDataURL;

    afterEach(() => {
      FileReader.prototype.readAsDataURL = original;
    });

    it('returns the read failure for that image without calling the API, and still sends the next one', async () => {
      let reads = 0;
      FileReader.prototype.readAsDataURL = function readAsDataURL(this: FileReader, blob: Blob) {
        reads += 1;
        if (reads === 1) {
          this.dispatchEvent(new Event('error'));
          return;
        }
        original.call(this, blob);
      };
      vi.mocked(uploadIssueDraftImage).mockResolvedValue(stored);
      const failures = await uploadIssueDraftImages(DRAFT_ID, [picked('a.png'), picked('b.png')]);
      expect(failures).toEqual([{ id: 'id-a.png', name: 'a.png', reason: IMAGE_READ_FAILED_REASON }]);
      expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);
      expect(uploadIssueDraftImage).toHaveBeenCalledWith(DRAFT_ID, { mimeType: 'image/png', data: 'YWJj' });
    });
  });

  it('does not throw: an unexpected error becomes a failure of that image', async () => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(new Error('boom'));
    const failures = await uploadIssueDraftImages(DRAFT_ID, [picked('a.png')]);
    expect(failures).toEqual([{ id: 'id-a.png', name: 'a.png', reason: '付けられませんでした。' }]);
  });

  it('does nothing for an empty list', async () => {
    const onProgress = vi.fn();
    await expect(uploadIssueDraftImages(DRAFT_ID, [], onProgress)).resolves.toEqual([]);
    expect(uploadIssueDraftImage).not.toHaveBeenCalled();
    expect(onProgress.mock.calls).toEqual([[0, 0]]);
  });
});
