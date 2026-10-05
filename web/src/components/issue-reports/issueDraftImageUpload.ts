import { ApiError } from '../../api';
import { uploadIssueDraftImage } from '../../api/issue-reports';
import { readFileAsDataUrl } from '../chat/attachments';
import { describeIssueDraftImageError } from './issueDraftErrors';
import { imageUploadPayload } from './issueDraftImages';

export interface PickedImage { readonly id: string; readonly file: File; readonly name: string }
export interface ImageUploadFailure { readonly id: string; readonly name: string; readonly reason: string }

/** 1 枚ずつ送って base64 の同時保持を避け、下書き全体の拒否では残りを止める。 */
export async function uploadIssueDraftImages(
  draftId: string,
  images: readonly PickedImage[],
  onProgress?: (sent: number, total: number) => void,
): Promise<ImageUploadFailure[]> {
  const failures: ImageUploadFailure[] = [];
  onProgress?.(0, images.length);
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (image === undefined) continue;
    let wholeDraftFailure = false;
    try {
      const dataUrl = await readFileAsDataUrl(image.file);
      const payload = imageUploadPayload(image.file, dataUrl);
      await uploadIssueDraftImage(draftId, payload);
    } catch (error) {
      failures.push({
        id: image.id,
        name: image.name,
        reason: error instanceof Error && error.message === '画像を読み込めませんでした。'
          ? '画像を読み込めませんでした。'
          : describeIssueDraftImageError(error),
      });
      wholeDraftFailure = error instanceof ApiError && [403, 404, 409, 507].includes(error.status);
    }
    onProgress?.(index + 1, images.length);
    if (wholeDraftFailure) {
      for (const remaining of images.slice(index + 1)) {
        failures.push({ id: remaining.id, name: remaining.name, reason: '送っていません (上と同じ原因で、残りの画像は送るのをやめました)。' });
      }
      break;
    }
  }
  return failures;
}
