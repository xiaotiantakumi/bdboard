import { ApiError } from '../../api';
import { uploadIssueDraftImage } from '../../api/issue-reports';
import { readFileAsDataUrl } from '../chat/attachments';
import { describeIssueDraftImageError } from './issueDraftErrors';
import { imageUploadPayload } from './issueDraftImages';

/** 書く画面で付けた 1 枚。`name` は一覧と失敗の表示に使う (貼り付けで名前が空のときは hook が付ける)。 */
export interface PickedImage {
  readonly id: string;
  readonly file: File;
  readonly name: string;
}

/** 付かなかった 1 枚。`reason` は利用者に出す文。 */
export interface ImageUploadFailure {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
  /**
   * サーバーが保存したのに、応答が届かなかっただけかもしれない (通信の失敗・想定外の応答)。true のときだけ付く。
   * 送り直す前に、サーバーにもう付いていないかを確かめる (issueDraftImageResend.ts。bdboard-8zwi)。
   * サーバーが保存せずに断った失敗 (400・403・404・409・413・507) と、送っていない画像には付けない。
   */
  readonly mayBeStored?: true;
}

export const IMAGE_READ_FAILED_REASON = '画像を読み込めませんでした。';
export const IMAGE_NOT_SENT_REASON = '送っていません (上と同じ原因で、残りの画像は送るのをやめました)。';

/**
 * 下書き全体に当たる失敗の status。残りの画像を送っても同じ理由で落ちる (下書きが無い・未処理でない・上限に達した・容量切れ・
 * ローカルでない) ので、ここで送るのをやめる。400・413・読み込みの失敗・通信の失敗はその 1 枚の事情なので、次へ進む。
 */
const DRAFT_WIDE_FAILURE_STATUSES: readonly number[] = [403, 404, 409, 507];

/** サーバーが画像を保存する前に断る status (本文の検査・下書きの状態・容量・大きさの上限)。これらなら、画像は付いていない。 */
const REFUSED_BEFORE_STORING_STATUSES: readonly number[] = [400, 403, 404, 409, 413, 507];

function isDraftWideFailure(error: unknown): boolean {
  return error instanceof ApiError && DRAFT_WIDE_FAILURE_STATUSES.includes(error.status);
}

/** 応答が届かなかった、または想定外の応答だった (サーバーが保存したかどうかは分からない)。 */
function mayHaveBeenStored(error: unknown): boolean {
  return !(error instanceof ApiError && REFUSED_BEFORE_STORING_STATUSES.includes(error.status));
}

type UploadOutcome =
  | { readonly ok: true; readonly fileName: string }
  | { readonly ok: false; readonly reason: string; readonly stopsRest: boolean; readonly mayBeStored: boolean };

/** 1 枚を読んで送る。読み込みの失敗と送信の失敗を分けて返す (投げない)。 */
async function uploadOne(draftId: string, image: PickedImage): Promise<UploadOutcome> {
  let dataUrl: string;
  try {
    dataUrl = await readFileAsDataUrl(image.file);
  } catch {
    return { ok: false, reason: IMAGE_READ_FAILED_REASON, stopsRest: false, mayBeStored: false };
  }
  try {
    const response = await uploadIssueDraftImage(draftId, imageUploadPayload(image.file, dataUrl));
    return { ok: true, fileName: response.image.fileName };
  } catch (error) {
    return {
      ok: false,
      reason: describeIssueDraftImageError(error),
      stopsRest: isDraftWideFailure(error),
      mayBeStored: mayHaveBeenStored(error),
    };
  }
}

/**
 * 下書きを作ったあとに、画像を **1 枚ずつ、前の応答を待ってから** 送る (bdboard-4y8q.6.9)。
 * 並列にしないのは、10 MiB 級の base64 を同時に何枚も持たないためと、サーバーが 1 枚ごとに枚数と容量を確かめるため。
 * 中身は送る直前に 1 枚だけ読む。この関数は投げず、付かなかった画像を返す (全部付けば空)。
 * 下書き全体に当たる失敗 (isDraftWideFailure) のときは、残りを送らず「送っていません」として返す。
 * `onStored` は、サーバーが保存を答えた 1 枚ごとに呼ぶ (サーバー側の file 名。送り直しで二重に付けないための目印。bdboard-8zwi)。
 */
export async function uploadIssueDraftImages(
  draftId: string,
  images: readonly PickedImage[],
  onProgress?: (sent: number, total: number) => void,
  onStored?: (image: PickedImage, fileName: string) => void,
): Promise<ImageUploadFailure[]> {
  const failures: ImageUploadFailure[] = [];
  onProgress?.(0, images.length);
  for (const [index, image] of images.entries()) {
    const outcome = await uploadOne(draftId, image);
    if (outcome.ok) {
      onStored?.(image, outcome.fileName);
    } else {
      failures.push({
        id: image.id,
        name: image.name,
        reason: outcome.reason,
        ...(outcome.mayBeStored ? { mayBeStored: true as const } : {}),
      });
    }
    onProgress?.(index + 1, images.length);
    if (!outcome.ok && outcome.stopsRest) {
      for (const skipped of images.slice(index + 1)) {
        failures.push({ id: skipped.id, name: skipped.name, reason: IMAGE_NOT_SENT_REASON });
      }
      break;
    }
  }
  return failures;
}
