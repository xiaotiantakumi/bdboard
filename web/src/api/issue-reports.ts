import { fetchJson } from './http';

/**
 * 不具合報告の下書き API (bdboard-4y8q.1 / 4y8q.3.1、docs/ISSUE-REPORTING.md 3節) の web 側の型と呼び出し。
 *
 * 型はサーバーの src/interface/http/issue-report-dto.ts と対になっている。web/ から src/ は import できない
 * (別 tsconfig・レイヤ境界) ので意図的な二重定義。画面が壊れないよう、サーバーが省くことのある欄
 * (トンネル経由の絞った形・古い下書き) はすべて省略可能にしてある。
 */

export const ISSUE_DRAFTS_API_PATH = '/api/issue-reports/drafts';
export const ISSUE_REPORTS_PENDING_COUNT_API_PATH = '/api/issue-reports/pending-count';

export type IssueDraftKind = 'A' | 'B' | 'C';
export type IssueDraftStatus = 'pending' | 'posted' | 'dismissed';

export interface IssueDraftSummaryDto {
  readonly id: string;
  readonly kind: IssueDraftKind;
  readonly fingerprint: string;
  readonly title: string;
  readonly status: IssueDraftStatus;
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly occurredProjectCount: number;
  readonly dismissReason?: string;
  readonly issueNumber?: number;
  readonly issueUrl?: string;
  readonly sourceTicketRef?: string;
}

export interface IssueDraftListDto {
  readonly drafts: readonly IssueDraftSummaryDto[];
  readonly pendingCount: number;
}

/** 発生時の環境。古い下書きや報告の仕方によって欄が欠けることがある。 */
export interface IssueDraftEnvInfoDto {
  readonly bdboardVersion?: string;
  readonly harnessVersion?: string;
  readonly os?: string;
  readonly nodeVersion?: string;
  readonly bdVersion?: string;
  readonly ghVersion?: string;
}

/**
 * 手元だけの情報。ローカル直アクセスでは全部、トンネル経由 (restricted: true) では
 * errorTextTruncated と envInfo だけが来る。
 */
export interface IssueDraftLocalOnlyDto {
  readonly symptomRaw?: string;
  readonly causeRaw?: string;
  readonly preventionRaw?: string;
  readonly errorTextRaw?: string;
  readonly errorTextHead?: string;
  readonly errorTextTail?: string;
  readonly errorTextTruncated?: boolean;
  readonly agentNoteRaw?: string;
  readonly envInfo?: IssueDraftEnvInfoDto;
  readonly foldedFingerprints?: readonly string[];
}

export interface IssueDraftOccurredProjectDto {
  readonly name: string;
  /** ローカル直アクセスだけ。トンネル経由では来ない。 */
  readonly path?: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * 置き換え漏れの疑い。start / end はその欄 (title / body) の UTF-16 オフセット (半開区間)。
 * kind はサーバーが増やしうるので string で受ける (知らない種類は画面が汎用の表示にする)。
 */
export interface IssueDraftSuspectedLeakDto {
  readonly field: 'title' | 'body';
  readonly kind: string;
  readonly start: number;
  readonly end: number;
}

export interface IssueDraftDetailDto {
  readonly id: string;
  readonly kind: IssueDraftKind;
  readonly fingerprint: string;
  readonly catalogSlug?: string;
  readonly source?: string;
  readonly title: string;
  readonly body: string;
  readonly titleEditedByUser: boolean;
  readonly bodyEditedByUser: boolean;
  readonly localOnly?: IssueDraftLocalOnlyDto;
  readonly occurredProjects?: readonly IssueDraftOccurredProjectDto[];
  readonly occurrenceCount: number;
  readonly firstOccurredAt: string;
  readonly lastOccurredAt: string;
  readonly status: IssueDraftStatus;
  readonly dismissReason?: string;
  readonly issueNumber?: number;
  readonly issueUrl?: string;
  readonly sourceTicketRef?: string;
  readonly harnessVersionAtOccurrence?: string;
  readonly suspectedLeaks?: readonly IssueDraftSuspectedLeakDto[];
  /** 上限で落とした疑いの件数 (サーバーは数。古い形や想定外の値にも画面が耐えるよう unknown 寄りに受ける)。 */
  readonly suspectedLeaksOmitted?: number | boolean;
  /** true: トンネル経由などで、手元の情報 (生ログ・パス) を省いた形。 */
  readonly restricted: boolean;
}

export interface IssueDraftImageDto {
  readonly fileName: string;
  readonly url: string;
  readonly byteLength: number;
  readonly createdAt: string;
}

export interface IssueDraftDetailResponseDto {
  readonly draft: IssueDraftDetailDto;
  readonly images?: readonly IssueDraftImageDto[];
  /** この bdboard が配る最新の harness pack の版。読めなければ null。 */
  readonly latestHarnessVersion?: string | null;
}

export interface IssueDraftEditResponseDto {
  readonly draft: IssueDraftDetailDto;
  /** 保存の上限に収めるため、手元の生ログの末尾を削った。 */
  readonly errorTextTrimmed: boolean;
}

export interface IssueDraftTextEdit {
  /** 空文字は、その欄を自動生成の内容へ戻す。 */
  readonly title?: string;
  readonly body?: string;
}

function draftPath(id: string): string {
  return `${ISSUE_DRAFTS_API_PATH}/${encodeURIComponent(id)}`;
}

export function fetchIssueDrafts(): Promise<IssueDraftListDto> {
  return fetchJson<IssueDraftListDto>(ISSUE_DRAFTS_API_PATH);
}

export function fetchIssueReportPendingCount(): Promise<{ pendingCount: number }> {
  return fetchJson<{ pendingCount: number }>(ISSUE_REPORTS_PENDING_COUNT_API_PATH);
}

export function fetchIssueDraft(id: string): Promise<IssueDraftDetailResponseDto> {
  return fetchJson<IssueDraftDetailResponseDto>(draftPath(id));
}

export function patchIssueDraft(id: string, edit: IssueDraftTextEdit): Promise<IssueDraftEditResponseDto> {
  return fetchJson<IssueDraftEditResponseDto>(draftPath(id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  });
}

export function dismissIssueDraft(id: string, reason: string): Promise<{ draft: IssueDraftSummaryDto }> {
  return fetchJson<{ draft: IssueDraftSummaryDto }>(`${draftPath(id)}/dismiss`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}
