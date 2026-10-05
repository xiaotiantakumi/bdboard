import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';

vi.mock('../../api/issue-reports', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/issue-reports')>(),
  uploadIssueDraftImage: vi.fn(),
}));
import { uploadIssueDraftImage } from '../../api/issue-reports';
import { uploadIssueDraftImages } from './issueDraftImageUpload';

function picked(name: string, id: string = name): { id: string; name: string; file: File } {
  return { id, name, file: new File(['abc'], name, { type: 'image/png' }) };
}

function apiError(status: number): ApiError {
  const code = status === 409 ? undefined : status === 507 ? 'storage-full' : undefined;
  return new ApiError(status, `HTTP ${status}`, { errorMessage: status === 403 ? 'local access only' : undefined, code });
}

describe('uploadIssueDraftImages', () => {
  beforeEach(() => {
    vi.mocked(uploadIssueDraftImage).mockReset();
  });
  it('sends sequentially and does not start the second upload until the first resolves', async () => {
    let finish: () => void = () => {};
    vi.mocked(uploadIssueDraftImage).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ image: { fileName: 'a', url: 'a', byteLength: 1, createdAt: 'now' } }); }));
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({ image: { fileName: 'b', url: 'b', byteLength: 1, createdAt: 'now' } });
    const promise = uploadIssueDraftImages('draft', [picked('a.png'), picked('b.png')]);
    await vi.waitFor(() => expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1));
    finish();
    await expect(promise).resolves.toEqual([]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2);
  });
  it('sends only base64 in a payload with the file MIME type', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({ image: { fileName: 'a', url: 'a', byteLength: 3, createdAt: 'now' } });
    await uploadIssueDraftImages('draft', [picked('a.png')]);
    expect(uploadIssueDraftImage).toHaveBeenCalledWith('draft', { mimeType: 'image/png', data: 'YWJj' });
  });
  it('returns no failures when all images succeed', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({ image: { fileName: 'a', url: 'a', byteLength: 3, createdAt: 'now' } });
    await expect(uploadIssueDraftImages('draft', [picked('a.png')])).resolves.toEqual([]);
  });
  it('continues after 400 failures, including when a later image also fails', async () => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(new ApiError(400, 'bad'));
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(new ApiError(413, 'large'));
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({ image: { fileName: 'c', url: 'c', byteLength: 1, createdAt: 'now' } });
    const failures = await uploadIssueDraftImages('draft', [picked('a'), picked('b'), picked('c')]);
    expect(failures).toHaveLength(2);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(3);
  });
  it.each([409, 507, 403, 404])('stops remaining uploads after draft-wide HTTP %s', async (status) => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(apiError(status));
    const failures = await uploadIssueDraftImages('draft', [picked('a'), picked('b'), picked('c')]);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(3);
    expect(failures[1]?.reason).toContain('送っていません');
  });
  it('continues after a network failure', async () => {
    vi.mocked(uploadIssueDraftImage).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({ image: { fileName: 'b', url: 'b', byteLength: 1, createdAt: 'now' } });
    expect(await uploadIssueDraftImages('draft', [picked('a'), picked('b')])).toHaveLength(1);
    expect(uploadIssueDraftImage).toHaveBeenCalledTimes(2);
  });
  it('returns a read failure and continues without throwing', async () => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function fail() { this.dispatchEvent(new Event('error')); };
    try {
      const failures = await uploadIssueDraftImages('draft', [picked('bad'), picked('next')]);
      expect(failures[0]?.reason).toBe('画像を読み込めませんでした。');
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }
  });
  it('reports progress from zero through the total', async () => {
    vi.mocked(uploadIssueDraftImage).mockResolvedValue({ image: { fileName: 'a', url: 'a', byteLength: 1, createdAt: 'now' } });
    const progress = vi.fn();
    await uploadIssueDraftImages('draft', [picked('a'), picked('b')], progress);
    expect(progress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
  });
});
