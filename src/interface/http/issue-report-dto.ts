import type { StoredDraftImage } from '../../application/ports/issue-draft-storage.js';
import type { IssueDraft, LocalOnlyContext, OccurredProject } from '../../domain/issue-draft.js';
import { foldHomePaths, foldHomePathsInValues } from '../../domain/issue-draft-identifier.js';

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

/**
 * 指紋 ("B:<source>:<hash>" の形) は、種別の印 ("B:") を残して後ろだけ畳む。"B:/Users/…" の "B:" を
 * Windows のドライブ文字として読んでしまわないため (畳むと印ごと消える)。
 */
function foldFingerprint(fingerprint: string): string {
  const colon = fingerprint.indexOf(':');
  return colon < 0 ? foldHomePaths(fingerprint) : fingerprint.slice(0, colon + 1) + foldHomePaths(fingerprint.slice(colon + 1));
}

/**
 * 一覧・受け取り・見送りの応答。本文と手元限定の中身 (生ログ・パス) は載せない。
 * 指紋と題名は、受け取りの時点でホーム配下のパスを畳んだ値のはずだが、念のためここでも畳む
 * (foldHomePaths。畳み損ねた値が、下書きの保存先へ直接書き込まれていた場合の備え)。
 */
export function toSummaryDto(draft: IssueDraft): IssueDraftSummaryDto {
  return {
    id: draft.id,
    kind: draft.kind,
    fingerprint: foldFingerprint(draft.fingerprint),
    title: foldHomePaths(draft.title),
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

/** 手元以外 (トンネル経由) へ返す手元限定の中身。生ログ・自由記述・パスは載せない。 */
export type RestrictedLocalOnlyDto = Pick<LocalOnlyContext, 'errorTextTruncated' | 'envInfo'>;
/** 手元以外へ返す発生プロジェクト。名前と時刻だけ。絶対パスは載せない。 */
export type RestrictedOccurredProjectDto = Omit<OccurredProject, 'path'>;

/** 1 件の取得の応答。手元 (ローカル直アクセス) には全部、そうでなければ絞った形。 */
export type IssueDraftDetailDto =
  | (IssueDraft & { readonly restricted: false })
  | (Omit<IssueDraft, 'localOnly' | 'occurredProjects'> & {
      readonly localOnly: RestrictedLocalOnlyDto;
      readonly occurredProjects: readonly RestrictedOccurredProjectDto[];
      readonly restricted: true;
    });

/**
 * 1 件の取得の応答 (GET drafts/:id)。
 *
 * ローカル直アクセスにだけ全部を返す。生ログ (errorTextRaw) と、それから切り出した先頭・末尾
 * (errorTextHead / errorTextTail。短いエラー文では生ログそのもの)、症状・原因・対策・メモの
 * 生の文、発生プロジェクトの絶対パスは、トークンやホームディレクトリを含みうる。トンネルの
 * Basic 認証を通っただけの読み手へ返すと持ち出しの経路になる (bdboard-54be.1 M-1 の run ログと
 * cwd を手元限定にしたのと同じ理由)。そちらでは `restricted: true` で、残すのは題名・本文・
 * 回数・時刻・プロジェクト名・版だけ。
 *
 * 許可リストで組む: 下書きに欄が増えても、ここへ足すまでは手元の外へ出ない。
 *
 * 名前や文を載せる欄 (source・catalogSlug・指紋・題名・本文・発生プロジェクトの名前・版の文字列) には
 * foldHomePaths をかけ、ホーム配下の絶対パスのユーザー名が残らないようにする (多層防御: 受け取りの時点で
 * 畳んであるはずの値だが、畳み方の漏れや、保存先へ直接書かれた値があっても出さない)。畳むのは
 * foldHomePaths が見つける決まった形だけで、それ以外の秘密の除去ではない (4y8q.2)。
 */
export function toDetailDto(draft: IssueDraft, access: { readonly local: boolean }): IssueDraftDetailDto {
  if (access.local) return { ...draft, restricted: false };
  return {
    id: draft.id,
    kind: draft.kind,
    fingerprint: foldFingerprint(draft.fingerprint),
    ...(draft.catalogSlug !== undefined ? { catalogSlug: foldHomePaths(draft.catalogSlug) } : {}),
    ...(draft.source !== undefined ? { source: foldHomePaths(draft.source) } : {}),
    title: foldHomePaths(draft.title),
    body: foldHomePaths(draft.body),
    titleEditedByUser: draft.titleEditedByUser,
    bodyEditedByUser: draft.bodyEditedByUser,
    localOnly: {
      errorTextTruncated: draft.localOnly.errorTextTruncated,
      envInfo: foldHomePathsInValues(draft.localOnly.envInfo),
    },
    occurredProjects: draft.occurredProjects.map((entry) => ({
      name: foldHomePaths(entry.name),
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
    })),
    occurrenceCount: draft.occurrenceCount,
    firstOccurredAt: draft.firstOccurredAt,
    lastOccurredAt: draft.lastOccurredAt,
    status: draft.status,
    ...(draft.dismissReason !== undefined ? { dismissReason: draft.dismissReason } : {}),
    ...(draft.issueNumber !== undefined ? { issueNumber: draft.issueNumber } : {}),
    ...(draft.issueUrl !== undefined ? { issueUrl: draft.issueUrl } : {}),
    ...(draft.sourceTicketRef !== undefined ? { sourceTicketRef: draft.sourceTicketRef } : {}),
    ...(draft.harnessVersionAtOccurrence !== undefined
      ? { harnessVersionAtOccurrence: foldHomePaths(draft.harnessVersionAtOccurrence) }
      : {}),
    draftSchemaVersion: draft.draftSchemaVersion,
    restricted: true,
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
