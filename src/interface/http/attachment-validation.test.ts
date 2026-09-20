import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  type AttachmentMimeType,
  contentTypeForGeneratedFileName,
  decodeAttachmentImage,
  extensionForMimeType,
  isGeneratedAttachmentFileName,
  isSafePathSegment,
} from './attachment-validation.js';

const signatures: Record<AttachmentMimeType, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
};

function encoded(
  mimeType: AttachmentMimeType,
  bytes: ArrayLike<number> = signatures[mimeType],
): string {
  return Buffer.from(bytes).toString('base64');
}

describe('decodeAttachmentImage', () => {
  it('decodes all four supported MIME types', () => {
    for (const mimeType of Object.keys(signatures) as AttachmentMimeType[]) {
      const result = decodeAttachmentImage(mimeType, encoded(mimeType));
      expect(result).toBeInstanceOf(Uint8Array);
    }
  });

  it('rejects magic bytes that do not match the declared MIME type', () => {
    expect(decodeAttachmentImage('image/png', encoded('image/jpeg'))).toBeUndefined();
    expect(decodeAttachmentImage('image/gif', encoded('image/png'))).toBeUndefined();
  });

  it('rejects an SVG disguised with an allowed MIME type', () => {
    const svg = Buffer.from('<svg onload="alert(1)"></svg>', 'utf8');
    expect(decodeAttachmentImage('image/png', svg.toString('base64'))).toBeUndefined();
  });

  it.each([
    ['whitespace', `${encoded('image/png')}\n`],
    ['data URL', `data:image/png;base64,${encoded('image/png')}`],
    ['invalid alphabet', '%%%%'],
    ['non-canonical padding', `${encoded('image/png')}=`],
  ])('rejects %s base64', (_label, data) => {
    expect(decodeAttachmentImage('image/png', data)).toBeUndefined();
  });

  it('rejects an empty and an oversized image', () => {
    expect(decodeAttachmentImage('image/png', '')).toBeUndefined();

    const oversized = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    oversized.set(signatures['image/png']);
    expect(decodeAttachmentImage('image/png', encoded('image/png', oversized))).toBeUndefined();
  });
});

describe('isSafePathSegment', () => {
  it('accepts typical ticket ids and project keys', () => {
    expect(isSafePathSegment('bdboard-qw26')).toBe(true);
    expect(isSafePathSegment('bdboard-3tw.104.24')).toBe(true);
    expect(isSafePathSegment('my_project-abc123')).toBe(true);
  });

  it('rejects path traversal and separators', () => {
    expect(isSafePathSegment('..')).toBe(false);
    expect(isSafePathSegment('.')).toBe(false);
    expect(isSafePathSegment('../etc/passwd')).toBe(false);
    expect(isSafePathSegment('a/b')).toBe(false);
    expect(isSafePathSegment('a\\b')).toBe(false);
    expect(isSafePathSegment('')).toBe(false);
    expect(isSafePathSegment('a\0b')).toBe(false);
  });
});

describe('generated file name round trip', () => {
  it('every mime type maps to an extension that regenerates a valid, matching file name', () => {
    for (const mimeType of Object.keys(signatures) as AttachmentMimeType[]) {
      const fileName = `1758300000000-0123456789abcdef.${extensionForMimeType(mimeType)}`;
      expect(isGeneratedAttachmentFileName(fileName)).toBe(true);
      expect(contentTypeForGeneratedFileName(fileName)).toBe(mimeType);
    }
  });

  it('rejects client-controlled or traversal-shaped file names', () => {
    expect(isGeneratedAttachmentFileName('../../etc/passwd.png')).toBe(false);
    expect(isGeneratedAttachmentFileName('photo.png')).toBe(false);
    expect(isGeneratedAttachmentFileName('1758300000000-0123456789abcdef.svg')).toBe(false);
    expect(isGeneratedAttachmentFileName('1758300000000-0123456789abcdef.PNG')).toBe(false);
    expect(contentTypeForGeneratedFileName('photo.png')).toBeUndefined();
  });
});
