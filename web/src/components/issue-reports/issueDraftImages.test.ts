import { describe, expect, it } from 'vitest';
import { imageUploadPayload, screenIssueDraftImages } from './issueDraftImages';
import { ISSUE_DRAFT_IMAGE_MAX_BYTES } from './issueDraftImageLimits';

describe('screenIssueDraftImages', () => {
  it('accepts each supported image type', () => {
    const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    expect(screenIssueDraftImages(0, types.map((type) => ({ name: type, type, size: 1 }))).accepted).toHaveLength(4);
  });
  it('accepts exactly 10 MiB and rejects one byte more with name and size', () => {
    const result = screenIssueDraftImages(0, [
      { name: 'ok.png', type: 'image/png', size: ISSUE_DRAFT_IMAGE_MAX_BYTES },
      { name: 'large.png', type: 'image/png', size: ISSUE_DRAFT_IMAGE_MAX_BYTES + 1 },
    ]);
    expect(result.accepted.map((file) => file.name)).toEqual(['ok.png']);
    expect(result.problems[0]).toContain('large.png');
    expect(result.problems[0]).toContain('10 MiB');
  });
  it('rejects empty files', () => {
    expect(screenIssueDraftImages(0, [{ name: 'empty.png', type: 'image/png', size: 0 }]).problems[0]).toContain('中身が空');
  });
  it.each(['image/svg+xml', 'image/bmp', 'application/pdf', ''])('rejects unsupported type %s', (type) => {
    expect(screenIssueDraftImages(0, [{ name: 'bad', type, size: 1 }]).problems[0]).toContain('付けられる形式');
  });
  it('accepts up to the count and combines remaining names into one problem', () => {
    const result = screenIssueDraftImages(18, ['a.png', 'b.png', 'c.png'].map((name) => ({ name, type: 'image/png', size: 1 })));
    expect(result.accepted.map((file) => file.name)).toEqual(['a.png', 'b.png']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('c.png');
  });
  it('rejects every image when the existing count is at the limit', () => {
    expect(screenIssueDraftImages(20, [{ name: 'a.png', type: 'image/png', size: 1 }]).accepted).toEqual([]);
  });
  it('preserves accepted order and reports invalid entries in input order', () => {
    const result = screenIssueDraftImages(0, [
      { name: 'one.png', type: 'image/png', size: 1 },
      { name: 'bad.svg', type: 'image/svg+xml', size: 1 },
      { name: 'two.gif', type: 'image/gif', size: 1 },
    ]);
    expect(result.accepted.map((file) => file.name)).toEqual(['one.png', 'two.gif']);
    expect(result.problems[0]).toContain('bad.svg');
  });
  it('uses a fallback for an empty name', () => {
    expect(screenIssueDraftImages(0, [{ name: '', type: 'image/svg+xml', size: 1 }]).problems[0]).toContain('名称なしの画像');
  });
  it('takes data after the first comma and rejects invalid type or delimiter', () => {
    const file = { name: 'a.png', type: 'image/png', size: 1 };
    expect(imageUploadPayload(file, 'data:image/png;base64,AAA,BBB').data).toBe('AAA,BBB');
    expect(() => imageUploadPayload({ ...file, type: 'image/svg+xml' }, 'data:,x')).toThrow();
    expect(() => imageUploadPayload(file, 'invalid')).toThrow('画像を送信形式に変換できませんでした。');
  });
});
