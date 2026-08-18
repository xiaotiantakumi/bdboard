import type {
  ChatImageAttachment,
  ChatImageMimeType,
} from '../../application/ports/chat-agent.js';

export const CHAT_IMAGE_MAX_COUNT = 4;
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGES_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** 10 MiB decoded -> about 13.34 MiB base64. JSON overheadを含め15 MiBで打ち切る。 */
export const CHAT_MESSAGE_BODY_MAX_BYTES = 15 * 1024 * 1024;

export interface EncodedChatImage {
  readonly mimeType: ChatImageMimeType;
  readonly data: string;
}

function hasExpectedMagicBytes(mimeType: ChatImageMimeType, data: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/png':
      return data.length >= 8 &&
        data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
        data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/webp':
      return data.length >= 12 &&
        data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;
  }
}

function decodeStrictBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0) return undefined;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!allowed) return undefined;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  // Buffer.from(base64) is permissive. Re-encoding closes any non-canonical forms that
  // happen to pass a future regex change, and Uint8Array.from keeps the application port
  // independent of Buffer's pooled backing storage.
  if (decoded.toString('base64') !== value) return undefined;
  return Uint8Array.from(decoded);
}

export function decodeChatImages(
  images: readonly EncodedChatImage[] | undefined,
): readonly ChatImageAttachment[] | undefined {
  if (images === undefined) return undefined;
  if (images.length > CHAT_IMAGE_MAX_COUNT) return undefined;

  const decodedImages: ChatImageAttachment[] = [];
  let totalBytes = 0;
  for (const image of images) {
    const data = decodeStrictBase64(image.data);
    if (data === undefined || data.byteLength > CHAT_IMAGE_MAX_BYTES) return undefined;
    totalBytes += data.byteLength;
    if (totalBytes > CHAT_IMAGES_MAX_TOTAL_BYTES) return undefined;
    if (!hasExpectedMagicBytes(image.mimeType, data)) return undefined;
    decodedImages.push({ mimeType: image.mimeType, data });
  }
  return decodedImages;
}
