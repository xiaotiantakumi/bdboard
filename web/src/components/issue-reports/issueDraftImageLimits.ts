/**
 * 下書きに付ける画像の上限と形式 (bdboard-4y8q.6.9)。サーバーが受け付けるものと同じ値にする。
 *
 * web/ から src/ は import できない (依存境界) ので、サーバーの定数を二重に持つ。対応は次のとおり:
 *   - ISSUE_DRAFT_IMAGE_MAX_COUNT = src/domain/issue-draft.ts の ISSUE_DRAFT_MAX_IMAGES
 *   - ISSUE_DRAFT_IMAGE_MAX_BYTES = src/interface/http/attachment-validation.ts の ATTACHMENT_MAX_BYTES
 *   - ISSUE_DRAFT_IMAGE_MIME_TYPES = 同じファイルの ATTACHMENT_ALLOWED_MIME_TYPES (extensionForMimeType の対象)
 * 値の一致は src/interface/http/issue-report-image-limits.test.ts が固定する。そのテストがこのファイルを単体で
 * 読んで評価するため、**このファイルは他のモジュールを import しない** (定数と型だけ)。
 */

/** 1 つの下書きに付けられる画像の枚数。 */
export const ISSUE_DRAFT_IMAGE_MAX_COUNT = 20;

/** 1 枚の大きさの上限 (バイト。10 MiB ちょうどは通る)。 */
export const ISSUE_DRAFT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** 付けられる形式。サーバーの並び順と同じ。 */
export const ISSUE_DRAFT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type IssueDraftImageMimeType = (typeof ISSUE_DRAFT_IMAGE_MIME_TYPES)[number];
