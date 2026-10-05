import type { StoredDraftImage } from '../../application/ports/issue-draft-storage.js';
import type { IssueDraft, LocalOnlyContext, OccurredProject } from '../../domain/issue-draft.js';
import { foldHomePaths, foldHomePathsInValues } from '../../domain/issue-draft-identifier.js';
import { displayedKeysOf, scanEditedText } from '../../domain/issue-draft-edit.js';

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

/** 指紋の頭の「種別の印」。A:<slug> / B:<source>:<hash> / C:<source>:<hash> / mass-occurrence:<kind>:<バケツ>。 */
const FINGERPRINT_KIND_MARKER = /^(?:[ABC]|mass-occurrence):/;

/**
 * 指紋は、種別の印 ("B:") があればそれを残して後ろだけ畳み、そのあと全体をもう一度畳む。
 * 印を残すのは、"B:/Users/…" の "B:" を Windows のドライブ文字として読んで印ごと消さないため。
 * 全体をもう一度畳むのは、印の形に見える文字列が実はドライブ文字のパス ("C:\Users\u\x:abcd") だった場合のため。
 * 印が無い指紋 ("/Users/u/x:abcd") は、最初の ":" で切らず全体を畳む。
 *
 * 取りこぼし (docs/ISSUE-REPORTING.md、bdboard-4lea)。どちらも受け取りを通らず、畳んでいない出どころが保存先へ
 * 直接書かれた指紋だけで起きる (受け取りは出どころを先に畳むので、"B:~/hook.ps1:abcd" の形で保存される):
 *   - 印の文字と同じドライブ文字のルート直下のパス ("B:\Users\u\hook.ps1:abcd") は、全体をドライブ付きのパスと読むので
 *     "~/hook.ps1:abcd" になり、印 ("B:") が消える。ユーザー名は残らない。印か Windows のドライブ文字かは、字面だけでは区別できない。
 *   - 印の文字と同じドライブ文字の、空白を含む名前 ("C:/Users/John Smith/x:abcd") は、印を残して後ろを POSIX の名前
 *     (空白で止まる) として畳むので "C:~/ Smith/x:abcd" になり、空白より後ろの名前の一部が残る。
 */
function foldFingerprint(fingerprint: string): string {
  const marker = FINGERPRINT_KIND_MARKER.exec(fingerprint)?.[0] ?? '';
  return foldHomePaths(marker + foldHomePaths(fingerprint.slice(marker.length)));
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
  const title = foldHomePaths(draft.title);
  const body = foldHomePaths(draft.body);
  return {
    id: draft.id,
    kind: draft.kind,
    fingerprint: foldFingerprint(draft.fingerprint),
    ...(draft.catalogSlug !== undefined ? { catalogSlug: foldHomePaths(draft.catalogSlug) } : {}),
    ...(draft.source !== undefined ? { source: foldHomePaths(draft.source) } : {}),
    title,
    body,
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
    ...restrictedLeaks(draft, title, body),
    draftSchemaVersion: draft.draftSchemaVersion,
    restricted: true,
  };
}

/**
 * トンネル側の置き換え漏れの疑い (bdboard-4y8q.3.1)。保存してある位置は畳む前の題名・本文の位置で、畳んだ文字列とは
 * ずれる (ホームのパスが "~/" に縮む)。そこで、返す (畳んだ) 題名・本文にかけ直す。位置は返す文字列の位置になる。
 * 鍵は**トンネルが既に見ているものだけ** (発生プロジェクトの表示名。根のパスは渡さない: displayedKeysOf)。疑いの種別は
 * 「鍵に一致したか」という本文に無い情報を返すので、隠したパス (と、その末尾のフォルダ名) を鍵にすると、推測のパスを本文に
 * 並べて当てて確かめる道具になる (レビュー M-1)。そのため、トンネル側にはパスの一致 (project-path) は出ず、ローカル側
 * (保存した疑い) より少ないことがある。直していない下書き (保存に無い) には足さない。
 */
function restrictedLeaks(
  draft: IssueDraft,
  title: string,
  body: string,
): Pick<IssueDraft, 'suspectedLeaks' | 'suspectedLeaksOmitted'> {
  if (draft.suspectedLeaks === undefined) return {};
  const scan = scanEditedText(
    { title, body, titleEdited: draft.titleEditedByUser, bodyEdited: draft.bodyEditedByUser },
    displayedKeysOf(draft.occurredProjects),
  );
  return { suspectedLeaks: scan.suspectedLeaks, suspectedLeaksOmitted: scan.omitted };
}

export function toImageDto(draftId: string, image: StoredDraftImage): IssueDraftImageDto {
  return {
    fileName: image.fileName,
    url: `${ISSUE_DRAFTS_PATH}/${encodeURIComponent(draftId)}/images/${encodeURIComponent(image.fileName)}`,
    byteLength: image.byteLength,
    createdAt: image.createdAt.toISOString(),
  };
}
