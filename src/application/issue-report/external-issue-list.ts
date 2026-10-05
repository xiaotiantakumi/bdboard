import type { ExternalIssue, ExternalIssueFailureKind } from '../ports/external-issue-source.js';
import type { PreparedExternalIssue, StoredExternalIssueSnapshot } from '../../domain/external-issue-snapshot-record.js';

/**
 * 届いた issue の一覧の形と、その部品 (bdboard-4y8q.9.3)。流れは `external-issue-service.ts`。
 */

/** 一覧の 1 件の「写し」の要約。写しそのもの (切り詰めた本文など) は `ExternalIssueSnapshotStoragePort.get` で読む。 */
export interface ExternalIssueSnapshotSummary {
  /** 写しを取った時刻 (最初に見た時点か、`resnapshot` で取り直した時点)。 */
  readonly snapshotAt: string;
  /** 写しを取った時点の GitHub の updatedAt。 */
  readonly updatedAt: string;
  /** 題名か本文が写しと違う印。取り直すまで残る。updatedAt だけの変化では立たない。 */
  readonly needsRejudge: boolean;
  /** 現在の updatedAt が写しのものと違う (印として返すだけ。コメントの追加やラベルの変更でも進む)。 */
  readonly updatedAtChanged: boolean;
}

/**
 * 一覧の 1 件。題名・本文・検査・updatedAt は GitHub の現在のもの (切り詰めた後)。`snapshot` が判定時点の写しの要約。
 * 第三者が書いた文章なので、画面に出すときは無害化する (4y8q.9.5)。
 */
export interface ExternalIssueEntry extends PreparedExternalIssue {
  readonly url: string;
  readonly author: string | null;
  readonly authorAssociation: string | null;
  readonly snapshot: ExternalIssueSnapshotSummary;
}

export type ExternalIssueListErrorKind =
  | ExternalIssueFailureKind
  /** bd の external_ref を読めなかった (紐付けが分からないので一覧を作らない)。 */
  | 'bd-failed'
  /** 写しを読めない・書けない。 */
  | 'storage-failed'
  | 'unexpected';

export interface ExternalIssueList {
  /** idle: まだ 1 度も確かめていない。ok: 直近の確認が最後まで通った。error: 直近の確認が途中で止まった (`error` に理由)。 */
  readonly state: 'idle' | 'ok' | 'error';
  /** 直近に成功した確認の時刻。error のときは、その前の成功の時刻 (無ければ null)。 */
  readonly fetchedAt: string | null;
  /** 直近に成功した確認の一覧。error のときは、その前の成功のまま (確認が止まった回の途中の結果は混ぜない)。 */
  readonly issues: readonly ExternalIssueEntry[];
  /** state が error のときだけ。`detail` は画面に出してよい短い固定の文言 (第三者の文章も stderr も含めない)。 */
  readonly error: { readonly kind: ExternalIssueListErrorKind; readonly detail: string } | null;
  /** 続きがありうる (gh のページの上限か、写しの上限 `EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT` で切った)。 */
  readonly truncated: boolean;
  /** gh の出力のうち読めずに捨てた行の数。 */
  readonly skippedLines: number;
}

export type ResnapshotResult =
  | { readonly ok: true; readonly snapshot: StoredExternalIssueSnapshot }
  /** not-listed: 直近の一覧に無い (取り直すのは一覧に載っている現在の内容)。 */
  | { readonly ok: false; readonly reason: 'not-listed' | 'storage-failed' };

export const EMPTY_LIST: ExternalIssueList = { state: 'idle', fetchedAt: null, issues: [], error: null, truncated: false, skippedLines: 0 };

/** 画面に出す理由。errno の code (ENOSPC など) だけを添える。パスやメッセージは入れない。 */
export function storageDetail(action: string, error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,19}$/.test(code) ? `${action} (${code})` : action;
}

/** ログに残す例外の種類。`name` が識別子の形のときだけ使い、それ以外は `unknown` (message や stack は渡さない)。 */
export function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : 'unknown';
}

export function summaryOf(record: StoredExternalIssueSnapshot, currentUpdatedAt: string): ExternalIssueSnapshotSummary {
  return {
    snapshotAt: record.snapshotAt,
    updatedAt: record.updatedAt,
    needsRejudge: record.needsRejudge,
    updatedAtChanged: record.updatedAt !== currentUpdatedAt,
  };
}

export function entryOf(issue: ExternalIssue, prepared: PreparedExternalIssue, record: StoredExternalIssueSnapshot): ExternalIssueEntry {
  return {
    ...prepared,
    url: issue.url,
    author: issue.author,
    authorAssociation: issue.authorAssociation,
    snapshot: summaryOf(record, prepared.updatedAt),
  };
}
