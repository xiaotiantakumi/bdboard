import { formatImageSize } from '../chat/attachments';
import {
  ISSUE_DRAFT_IMAGE_MAX_BYTES,
  ISSUE_DRAFT_IMAGE_MAX_COUNT,
  ISSUE_DRAFT_IMAGE_MIME_TYPES,
  type IssueDraftImageMimeType,
} from './issueDraftImageLimits';

export interface ImageFileLike { readonly name: string; readonly type: string; readonly size: number }

export function isIssueDraftImageMimeType(value: string): value is IssueDraftImageMimeType {
  return ISSUE_DRAFT_IMAGE_MIME_TYPES.some((mimeType) => mimeType === value);
}

function displayName(name: string): string {
  return name || '名称なしの画像';
}

export function screenIssueDraftImages<T extends ImageFileLike>(
  existingCount: number,
  incoming: readonly T[],
): { accepted: T[]; problems: string[] } {
  const accepted: T[] = [];
  const problems: string[] = [];
  const overLimit: string[] = [];
  for (const file of incoming) {
    const name = displayName(file.name);
    if (!isIssueDraftImageMimeType(file.type)) {
      problems.push(`「${name}」は付けられません。付けられる形式は PNG・JPEG・WebP・GIF です。`);
    } else if (file.size === 0) {
      problems.push(`「${name}」は中身が空のため付けられません。`);
    } else if (file.size > ISSUE_DRAFT_IMAGE_MAX_BYTES) {
      problems.push(`「${name}」は 10 MiB を超えているため付けられません (${formatImageSize(file.size)})。`);
    } else if (existingCount + accepted.length < ISSUE_DRAFT_IMAGE_MAX_COUNT) {
      accepted.push(file);
    } else {
      overLimit.push(name);
    }
  }
  if (overLimit.length > 0) {
    problems.push(`画像は ${ISSUE_DRAFT_IMAGE_MAX_COUNT} 枚までです。次の画像は付けませんでした: ${overLimit.map((name) => `「${name}」`).join('')}`);
  }
  return { accepted, problems };
}

export function imageUploadPayload(file: ImageFileLike, dataUrl: string): { mimeType: IssueDraftImageMimeType; data: string } {
  if (!isIssueDraftImageMimeType(file.type)) throw new Error('付けられる形式の画像ではありません。');
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) throw new Error('画像を送信形式に変換できませんでした。');
  return { mimeType: file.type, data: dataUrl.slice(commaIndex + 1) };
}
