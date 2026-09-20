// bdboard-sso1.2: ChatPanel.tsx から画像添付まわりの純粋ヘルパーを移動しただけの
// ファイル。挙動は一切変えていない (関数本体・型定義はコピーのみ)。
import type { ChatImageMimeType, ChatImagePayload } from '../../api';

export type ChatMessageImage = {
  previewUrl: string;
  name: string;
  size: number;
};

export type ChatAttachment = ChatMessageImage & {
  id: string;
  file: File;
  mimeType: ChatImageMimeType;
};

export const CHAT_IMAGE_ONLY_PROMPT = '添付画像の内容を説明してください。';
const CHAT_IMAGE_MAX_COUNT = 4;
const CHAT_IMAGE_MAX_FILE_BYTES = 5 * 1024 * 1024;
const CHAT_IMAGE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const CHAT_IMAGE_TYPES: readonly ChatImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

function isChatImageMimeType(value: string): value is ChatImageMimeType {
  return CHAT_IMAGE_TYPES.some((mimeType) => mimeType === value);
}

export function validateChatAttachments(
  existing: readonly ChatAttachment[],
  incoming: readonly File[],
): string | null {
  const unsupported = incoming.find((file) => !isChatImageMimeType(file.type));
  if (unsupported !== undefined) {
    return 'PNG・JPEG・WebP 形式の画像だけ貼り付けられます。';
  }
  if (existing.length + incoming.length > CHAT_IMAGE_MAX_COUNT) {
    return `画像は最大 ${CHAT_IMAGE_MAX_COUNT} 枚まで添付できます。`;
  }
  const oversized = incoming.find((file) => file.size > CHAT_IMAGE_MAX_FILE_BYTES);
  if (oversized !== undefined) {
    return `「${oversized.name || '名称なしの画像'}」は 5 MiB を超えています。`;
  }
  const totalBytes =
    existing.reduce((total, attachment) => total + attachment.size, 0) +
    incoming.reduce((total, file) => total + file.size, 0);
  if (totalBytes > CHAT_IMAGE_MAX_TOTAL_BYTES) {
    return '画像の合計サイズは 10 MiB 以下にしてください。';
  }
  return null;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('画像を読み込めませんでした。'));
      }
    });
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('画像を読み込めませんでした。')),
    );
    reader.readAsDataURL(file);
  });
}

export function attachmentsToPayload(
  attachments: readonly ChatAttachment[],
): ChatImagePayload[] {
  return attachments.map((attachment) => {
    const dataUrl = attachment.previewUrl;
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex < 0) {
      throw new Error('画像を送信形式に変換できませんでした。');
    }
    return {
      mimeType: attachment.mimeType,
      data: dataUrl.slice(commaIndex + 1),
    };
  });
}

export function formatImageSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
}
