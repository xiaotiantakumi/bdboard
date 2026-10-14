import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueDraftDetailResponseDto, IssueDraftImageDto } from '../../api/issue-reports';
import { findImagesAlreadyStored } from './issueDraftImageResend';
import type { PickedImage } from './issueDraftImageUpload';

vi.mock('../../api/issue-reports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/issue-reports')>();
  return { ...actual, fetchIssueDraft: vi.fn(), fetchIssueDraftImageBytes: vi.fn() };
});

import { fetchIssueDraft, fetchIssueDraftImageBytes } from '../../api/issue-reports';

/** bdboard-8zwi: 再送の前に、送ったのに応答が届かなかった画像がサーバーにもう付いているかを、大きさと中身で見比べる。 */

const DRAFT_ID = '1758812345678-a1b2c3d4e5f6a7b8';

function picked(name: string, contents: string): PickedImage {
  return { id: `id-${name}`, name, file: new File([contents], name, { type: 'image/png' }) };
}

function onServer(fileName: string, contents: string): IssueDraftImageDto {
  return {
    fileName,
    url: `/api/issue-reports/drafts/${DRAFT_ID}/images/${fileName}`,
    byteLength: new TextEncoder().encode(contents).byteLength,
    createdAt: '2026-10-06T00:00:00.000Z',
  };
}

/** サーバーにある画像 (file 名 → 中身) を、一覧と中身の取得の両方に見せる。 */
function serverHas(images: Record<string, string>) {
  const dtos = Object.entries(images).map(([fileName, contents]) => onServer(fileName, contents));
  vi.mocked(fetchIssueDraft).mockResolvedValue({ images: dtos } as unknown as IssueDraftDetailResponseDto);
  vi.mocked(fetchIssueDraftImageBytes).mockImplementation((url: string) => {
    const fileName = url.slice(url.lastIndexOf('/') + 1);
    const contents = images[fileName];
    return contents === undefined
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(new TextEncoder().encode(contents).buffer as ArrayBuffer);
  });
}

describe('findImagesAlreadyStored (bdboard-8zwi)', () => {
  beforeEach(() => {
    vi.mocked(fetchIssueDraft).mockReset();
    vi.mocked(fetchIssueDraftImageBytes).mockReset();
  });

  it('finds an image that the server already has, by the same size and the same bytes', async () => {
    serverHas({ '1-aaaa.png': 'AAAA' });
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('a.png', 'AAAA')], new Set());
    expect(found).toEqual(new Map([['id-a.png', '1-aaaa.png']]));
    expect(fetchIssueDraft).toHaveBeenCalledWith(DRAFT_ID);
  });

  it('does not take an image of the same size but different bytes for the same image', async () => {
    serverHas({ '1-aaaa.png': 'AAAA' });
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('b.png', 'BBBB')], new Set());
    expect(found.size).toBe(0);
  });

  it('does not even fetch the bytes of an image of a different size', async () => {
    serverHas({ '1-aaaa.png': 'AAAA' });
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('long.png', 'AAAAAAAA')], new Set());
    expect(found.size).toBe(0);
    expect(fetchIssueDraftImageBytes).not.toHaveBeenCalled();
  });

  it('leaves out the server images this screen already knows it stored, so attaching the same picture twice is not collapsed', async () => {
    // 同じ画像を 2 枚付けた。1 枚目は保存できたと分かっていて、2 枚目だけ応答が届かなかった。サーバーには 1 枚しか無い。
    serverHas({ '1-aaaa.png': 'AAAA' });
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('second.png', 'AAAA')], new Set(['1-aaaa.png']));
    expect(found.size).toBe(0);
    expect(fetchIssueDraftImageBytes).not.toHaveBeenCalled();
  });

  it('finds the second copy when the server holds both and only the first one is known', async () => {
    serverHas({ '1-aaaa.png': 'AAAA', '2-aaaa.png': 'AAAA' });
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('second.png', 'AAAA')], new Set(['1-aaaa.png']));
    expect(found).toEqual(new Map([['id-second.png', '2-aaaa.png']]));
  });

  it('gives each server image to one picked image only', async () => {
    serverHas({ '1-aaaa.png': 'AAAA' });
    const found = await findImagesAlreadyStored(
      DRAFT_ID,
      [picked('first.png', 'AAAA'), picked('second.png', 'AAAA')],
      new Set(),
    );
    expect(found).toEqual(new Map([['id-first.png', '1-aaaa.png']]));
  });

  it('matches several images independently, telling same-size images apart by their bytes', async () => {
    serverHas({ '1-bbbb.png': 'BBBB', '2-cccc.png': 'CCCC' });
    const found = await findImagesAlreadyStored(
      DRAFT_ID,
      [picked('a.png', 'AAAA'), picked('b.png', 'BBBB'), picked('c.png', 'CCCC')],
      new Set(),
    );
    expect(found).toEqual(
      new Map([
        ['id-b.png', '1-bbbb.png'],
        ['id-c.png', '2-cccc.png'],
      ]),
    );
  });

  it('asks the server for nothing when there is no candidate', async () => {
    const found = await findImagesAlreadyStored(DRAFT_ID, [], new Set());
    expect(found.size).toBe(0);
    expect(fetchIssueDraft).not.toHaveBeenCalled();
  });

  it('treats every image as not stored when the list cannot be fetched, so the retry still sends them', async () => {
    vi.mocked(fetchIssueDraft).mockRejectedValue(new TypeError('Failed to fetch'));
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('a.png', 'AAAA')], new Set());
    expect(found.size).toBe(0);
  });

  it('treats the images as not stored when the draft has no image list (a restricted answer)', async () => {
    vi.mocked(fetchIssueDraft).mockResolvedValue({} as unknown as IssueDraftDetailResponseDto);
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('a.png', 'AAAA')], new Set());
    expect(found.size).toBe(0);
  });

  it('treats an image as not stored when its bytes cannot be fetched', async () => {
    vi.mocked(fetchIssueDraft).mockResolvedValue({
      images: [onServer('1-aaaa.png', 'AAAA')],
    } as unknown as IssueDraftDetailResponseDto);
    vi.mocked(fetchIssueDraftImageBytes).mockRejectedValue(new Error('HTTP 404'));
    const found = await findImagesAlreadyStored(DRAFT_ID, [picked('a.png', 'AAAA')], new Set());
    expect(found.size).toBe(0);
  });
});
