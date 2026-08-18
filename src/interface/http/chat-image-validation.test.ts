import { describe, expect, it } from 'vitest';
import type { ChatImageMimeType } from '../../application/ports/chat-agent.js';
import {
  CHAT_IMAGE_MAX_BYTES,
  decodeChatImages,
  type EncodedChatImage,
} from './chat-image-validation.js';

const signatures: Record<ChatImageMimeType, readonly number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};

function encoded(
  mimeType: ChatImageMimeType,
  bytes: ArrayLike<number> = signatures[mimeType],
): EncodedChatImage {
  return { mimeType, data: Buffer.from(bytes).toString('base64') };
}

describe('decodeChatImages', () => {
  it('strictly decodes the three supported MIME types to Uint8Array', () => {
    const result = decodeChatImages([
      encoded('image/png'),
      encoded('image/jpeg'),
      encoded('image/webp'),
    ]);
    expect(result?.map((image) => image.mimeType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ]);
    expect(result?.every((image) => image.data instanceof Uint8Array)).toBe(true);
  });

  it.each([
    ['whitespace', `${encoded('image/png').data}\n`],
    ['data URL', `data:image/png;base64,${encoded('image/png').data}`],
    ['invalid alphabet', '%%%%'],
    ['non-canonical padding', `${encoded('image/png').data}=`],
  ])('rejects %s base64', (_label, data) => {
    expect(decodeChatImages([{ mimeType: 'image/png', data }])).toBeUndefined();
  });

  it('rejects magic bytes that do not match the declared MIME type', () => {
    expect(decodeChatImages([
      { ...encoded('image/jpeg'), mimeType: 'image/png' },
    ])).toBeUndefined();
  });

  it('rejects more than four images, an oversized image, and an oversized total', () => {
    expect(decodeChatImages(Array.from({ length: 5 }, () => encoded('image/png'))))
      .toBeUndefined();

    const oversized = new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1);
    oversized.set(signatures['image/png']);
    expect(decodeChatImages([encoded('image/png', oversized)])).toBeUndefined();

    const fourMiB = new Uint8Array(4 * 1024 * 1024);
    fourMiB.set(signatures['image/png']);
    expect(decodeChatImages([
      encoded('image/png', fourMiB),
      encoded('image/png', fourMiB),
      encoded('image/png', fourMiB),
    ])).toBeUndefined();
  });
});
