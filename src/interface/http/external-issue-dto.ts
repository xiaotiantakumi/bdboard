import type { ExternalIssueEntry, ExternalIssueList } from '../../application/issue-report/external-issue-list.js';
import type { MachineCheckResult } from '../../domain/external-issue-checks.js';

/**
 * 届いた issue の読み取り API の形 (bdboard-4y8q.9.4、docs/ISSUE-REPORTING.md 8節)。
 *
 * 題名・本文は第三者が書いた文章で、切り詰めた後の現在の GitHub の内容。画面に出すときは無害化する (4y8q.9.5)。
 * 欄は 1 つずつ書き写す (スプレッドにしない): サービスの型に欄が増えても、API に勝手に出ないようにするため。
 */
export interface ExternalIssueDto {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string | null;
  readonly authorAssociation: string | null;
  readonly url: string;
  /** GitHub の現在の updatedAt。 */
  readonly updatedAt: string;
  readonly titleTruncated: boolean;
  readonly bodyTruncated: boolean;
  /** 切る前の長さ (コードポイント)。 */
  readonly titleLength: number;
  readonly bodyLength: number;
  /** 機械の検査の結果 (判断は含まない)。 */
  readonly checks: MachineCheckResult;
  /** 判定時点の写しを取った時刻。 */
  readonly snapshotAt: string;
  /** 題名か本文が写しと違う印。取り直す (resnapshot) まで残る。updatedAt だけの変化では立たない。 */
  readonly needsRejudge: boolean;
  /** 現在の updatedAt が写しのものと違う (印として返すだけ)。 */
  readonly updatedAtChanged: boolean;
}

export interface ExternalIssueListDto {
  /** メンテナ環境でない、または BDBOARD_EXTERNAL_ISSUES_DISABLED で止めたときは false (gh も bd も呼ばず、一覧は空)。 */
  readonly enabled: boolean;
  readonly state: 'idle' | 'ok' | 'error';
  readonly fetchedAt: string | null;
  readonly error: { readonly kind: string; readonly detail: string } | null;
  readonly truncated: boolean;
  readonly skippedLines: number;
  readonly issues: readonly ExternalIssueDto[];
}

function toExternalIssueDto(entry: ExternalIssueEntry): ExternalIssueDto {
  return {
    number: entry.number,
    title: entry.title,
    body: entry.body,
    author: entry.author,
    authorAssociation: entry.authorAssociation,
    url: entry.url,
    updatedAt: entry.updatedAt,
    titleTruncated: entry.titleTruncated,
    bodyTruncated: entry.bodyTruncated,
    titleLength: entry.titleLength,
    bodyLength: entry.bodyLength,
    checks: entry.checks,
    snapshotAt: entry.snapshot.snapshotAt,
    needsRejudge: entry.snapshot.needsRejudge,
    updatedAtChanged: entry.snapshot.updatedAtChanged,
  };
}

export function toExternalIssueListDto(list: ExternalIssueList): ExternalIssueListDto {
  return {
    enabled: true,
    state: list.state,
    fetchedAt: list.fetchedAt,
    error: list.error === null ? null : { kind: list.error.kind, detail: list.error.detail },
    truncated: list.truncated,
    skippedLines: list.skippedLines,
    issues: list.issues.map(toExternalIssueDto),
  };
}

/** 無効のとき (サービスが無いとき。メンテナ環境でない、または BDBOARD_EXTERNAL_ISSUES_DISABLED) の応答。 */
export const DISABLED_EXTERNAL_ISSUE_LIST_DTO: ExternalIssueListDto = {
  enabled: false,
  state: 'idle',
  fetchedAt: null,
  error: null,
  truncated: false,
  skippedLines: 0,
  issues: [],
};
