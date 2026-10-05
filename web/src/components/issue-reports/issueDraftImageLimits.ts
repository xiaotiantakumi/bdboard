/** src/domain/issue-draft.ts の ISSUE_DRAFT_MAX_IMAGES と src/interface/http/attachment-validation.ts の値に対応する。web/ から src/ は import できないため二重定義し、値は src/interface/http/issue-report-image-limits.test.ts が固定する。 */
export const ISSUE_DRAFT_IMAGE_MAX_COUNT = 20;
export const ISSUE_DRAFT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const ISSUE_DRAFT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type IssueDraftImageMimeType = (typeof ISSUE_DRAFT_IMAGE_MIME_TYPES)[number];
