import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_IMAGE_MAX_BYTES, ISSUE_DRAFT_IMAGE_MAX_COUNT } from './issueDraftImageLimits';
import {
  ISSUE_DRAFT_IMAGE_MAX_SIZE_LABEL,
  imageUploadPayload,
  isIssueDraftImageMimeType,
  screenIssueDraftImages,
  type ImageFileLike,
} from './issueDraftImages';

function png(name: string, size = 1): ImageFileLike {
  return { name, type: 'image/png', size };
}

describe('isIssueDraftImageMimeType', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('accepts %s', (type) => {
    expect(isIssueDraftImageMimeType(type)).toBe(true);
  });

  it.each(['image/svg+xml', 'image/bmp', 'image/avif', 'application/pdf', 'IMAGE/PNG', ''])('rejects %s', (type) => {
    expect(isIssueDraftImageMimeType(type)).toBe(false);
  });
});

describe('screenIssueDraftImages: format, emptiness and size (bdboard-4y8q.6.9)', () => {
  it('accepts each supported image type', () => {
    const files = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].map((type) => ({ name: type, type, size: 1 }));
    const result = screenIssueDraftImages(0, files);
    expect(result.accepted).toEqual(files);
    expect(result.problems).toEqual([]);
  });

  it('says the limit in MiB, derived from the byte limit', () => {
    expect(ISSUE_DRAFT_IMAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(ISSUE_DRAFT_IMAGE_MAX_SIZE_LABEL).toBe('10 MiB');
  });

  it('accepts exactly 10 MiB', () => {
    const result = screenIssueDraftImages(0, [png('exact.png', ISSUE_DRAFT_IMAGE_MAX_BYTES)]);
    expect(result.accepted.map((file) => file.name)).toEqual(['exact.png']);
    expect(result.problems).toEqual([]);
  });

  it('refuses one byte over 10 MiB, naming the file and showing its size', () => {
    const result = screenIssueDraftImages(0, [png('large.png', ISSUE_DRAFT_IMAGE_MAX_BYTES + 1)]);
    expect(result.accepted).toEqual([]);
    expect(result.problems).toEqual(['「large.png」は 10 MiB を超えているため付けられません (10.0 MiB)。']);
  });

  it('refuses an empty file (the server answers 400 for zero bytes)', () => {
    const result = screenIssueDraftImages(0, [png('empty.png', 0)]);
    expect(result.accepted).toEqual([]);
    expect(result.problems).toEqual(['「empty.png」は中身が空のため付けられません。']);
  });

  it.each(['image/svg+xml', 'image/bmp', 'application/pdf', ''])('refuses the type "%s" and lists the supported formats', (type) => {
    const result = screenIssueDraftImages(0, [{ name: 'bad', type, size: 1 }]);
    expect(result.accepted).toEqual([]);
    expect(result.problems).toEqual(['「bad」は付けられません。付けられる形式は PNG・JPEG・WebP・GIF です。']);
  });

  it('keeps the valid files in input order and reports each refused file in input order', () => {
    const result = screenIssueDraftImages(0, [
      png('one.png'),
      { name: 'bad.svg', type: 'image/svg+xml', size: 1 },
      { name: 'two.gif', type: 'image/gif', size: 1 },
      png('empty.png', 0),
    ]);
    expect(result.accepted.map((file) => file.name)).toEqual(['one.png', 'two.gif']);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain('bad.svg');
    expect(result.problems[1]).toContain('empty.png');
  });

  it('shows a placeholder for a file with no name', () => {
    const result = screenIssueDraftImages(0, [{ name: '', type: 'image/svg+xml', size: 1 }]);
    expect(result.problems[0]).toContain('「名称なしの画像」');
  });

  it('returns the same objects it was given (so callers keep their File)', () => {
    const file = png('same.png');
    expect(screenIssueDraftImages(0, [file]).accepted[0]).toBe(file);
  });
});

describe('screenIssueDraftImages: count (bdboard-4y8q.6.9)', () => {
  it('takes images up to the limit counting the ones already attached, and reports the rest in one problem', () => {
    const result = screenIssueDraftImages(18, [png('a.png'), png('b.png'), png('c.png'), png('d.png')]);
    expect(result.accepted.map((file) => file.name)).toEqual(['a.png', 'b.png']);
    expect(result.problems).toEqual(['画像は 20 枚までです。次の画像は付けませんでした: 「c.png」「d.png」']);
  });

  it('takes nothing when the limit is already reached', () => {
    const result = screenIssueDraftImages(ISSUE_DRAFT_IMAGE_MAX_COUNT, [png('a.png')]);
    expect(result.accepted).toEqual([]);
    expect(result.problems).toEqual(['画像は 20 枚までです。次の画像は付けませんでした: 「a.png」']);
  });

  it('takes exactly 20 images in one go', () => {
    const files = Array.from({ length: 20 }, (_, index) => png(`${index}.png`));
    const result = screenIssueDraftImages(0, files);
    expect(result.accepted).toHaveLength(20);
    expect(result.problems).toEqual([]);
  });

  it('does not count a refused image against the limit', () => {
    const result = screenIssueDraftImages(19, [png('big.png', ISSUE_DRAFT_IMAGE_MAX_BYTES + 1), png('ok.png')]);
    expect(result.accepted.map((file) => file.name)).toEqual(['ok.png']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('big.png');
  });
});

describe('imageUploadPayload', () => {
  it('returns the MIME type of the file and the base64 after the data URL prefix', () => {
    expect(imageUploadPayload(png('a.png'), 'data:image/png;base64,QUJD')).toEqual({
      mimeType: 'image/png',
      data: 'QUJD',
    });
  });

  it('cuts at the first comma only', () => {
    expect(imageUploadPayload(png('a.png'), 'data:image/png;base64,AAA,BBB').data).toBe('AAA,BBB');
  });

  it('throws for a type the server would not accept', () => {
    const svg = { name: 'a.svg', type: 'image/svg+xml', size: 1 };
    expect(() => imageUploadPayload(svg, 'data:image/svg+xml;base64,QUJD')).toThrow('付けられる形式の画像ではありません。');
  });

  it('throws when the data URL has no comma', () => {
    expect(() => imageUploadPayload(png('a.png'), 'not-a-data-url')).toThrow('画像を送信形式に変換できませんでした。');
  });
});
