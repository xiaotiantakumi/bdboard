import type { StoredDraftImage } from '../../application/ports/issue-draft-storage.js';
import type { IssueDraft } from '../../domain/issue-draft.js';

/** 不具合報告の下書き API (bdboard-4y8q.1) の応答の形。 */

export const ISSUE_DRAFTS_PATH = '/api/issue-reports/drafts';

export interface IssueDraftSummaryDto {
  readonly id: string;
  readonly kind: IssueDraft['kind'];
  readonly fingerprint: string;
  readonly title: string;
  readonly status: IssueDraft['status'];
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly occurredProjectCount: number;
  readonly dismissReason?: string;
  readonly issueNumber?: number;
  readonly issueUrl?: string;
  readonly sourceTicketRef?: string;
}

export interface IssueDraftImageDto {
  readonly fileName: string;
  readonly url: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

/** 一覧・受け取り・見送りの応答。本文と手元限定の中身 (生ログ・パス) は載せない。 */
export function toSummaryDto(draft: IssueDraft): IssueDraftSummaryDto {
  return {
    id: draft.id,
    kind: draft.kind,
    fingerprint: draft.fingerprint,
    title: draft.title,
    status: draft.status,
    occurrenceCount: draft.occurrenceCount,
    firstOccurredAt: draft.firstOccurredAt,
    lastOccurredAt: draft.lastOccurredAt,
    occurredProjectCount: draft.occurredProjects.length,
    ...(draft.dismissReason !== undefined ? { dismissReason: draft.dismissReason } : {}),
    ...(draft.issueNumber !== undefined ? { issueNumber: draft.issueNumber } : {}),
    ...(draft.issueUrl !== undefined ? { issueUrl: draft.issueUrl } : {}),
    ...(draft.sourceTicketRef !== undefined ? { sourceTicketRef: draft.sourceTicketRef } : {}),
  };
}

export function toImageDto(draftId: string, image: StoredDraftImage): IssueDraftImageDto {
  return {
    fileName: image.fileName,
    url: `${ISSUE_DRAFTS_PATH}/${encodeURIComponent(draftId)}/images/${encodeURIComponent(image.fileName)}`,
    byteLength: image.byteLength,
    createdAt: image.createdAt.toISOString(),
  };
}
