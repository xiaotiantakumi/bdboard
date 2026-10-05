import { ApiError, fetchJson } from './http';

/**
 * 届いた issue (ほかの人が GitHub に出した open issue) の読み取り API (bdboard-4y8q.9.4 / 4y8q.9.5、docs/ISSUE-REPORTING.md 8節) の
 * web 側の型と呼び出し。
 *
 * 型はサーバーの src/interface/http/external-issue-dto.ts と対になっている。web/ から src/ は import できない
 * (別 tsconfig・レイヤ境界) ので意図的な二重定義。題名・本文・作者・URL は第三者が書いた文字列で、画面では文字としてだけ出す。
 * 呼び出しを issue-reports.ts に足さずこのファイルに置いたのは、並行する下書き側の変更と衝突させないため (逸脱表 4)。
 */

export const EXTERNAL_ISSUES_API_PATH = '/api/issue-reports/external';
export const EXTERNAL_ISSUES_REFRESH_API_PATH = '/api/issue-reports/external/refresh';

export interface ExternalInvisibleCharKind {
  /** `U+200B` の形。範囲の種類 (タグ文字) は `U+E0000..U+E007F`。 */
  readonly codePoint: string;
  readonly name: string;
  readonly group: string;
  readonly count: number;
  readonly positions: readonly number[];
}

/** 1 つの文字列 (題名か本文) にかけた機械の検査の結果。数と位置だけで、判断は含まない。 */
export interface ExternalTextChecks {
  readonly invisibleChars: { readonly total: number; readonly kinds: readonly ExternalInvisibleCharKind[] };
  readonly htmlComments: {
    readonly count: number;
    readonly unclosed: boolean;
    readonly totalChars: number;
    readonly spans: readonly { readonly start: number; readonly end: number; readonly length: number; readonly closed: boolean }[];
  };
  readonly longEncodedStrings: {
    readonly count: number;
    readonly longest: number;
    readonly spans: readonly { readonly start: number; readonly length: number }[];
  };
  readonly links: {
    readonly total: number;
    readonly markdownLinks: number;
    readonly autolinks: number;
    readonly referenceDefinitions: number;
    readonly rawUrls: number;
  };
}

export interface ExternalMachineChecks {
  readonly title: ExternalTextChecks;
  readonly body: ExternalTextChecks;
}

export interface ExternalIssueDto {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string | null;
  readonly authorAssociation: string | null;
  readonly url: string;
  readonly updatedAt: string;
  readonly titleTruncated: boolean;
  readonly bodyTruncated: boolean;
  /** 切る前の長さ (コードポイント)。検査の位置・長さ (UTF-16) とは単位が違うので、並べて「文字数」と呼ばない。 */
  readonly titleLength: number;
  readonly bodyLength: number;
  readonly checks: ExternalMachineChecks;
  readonly snapshotAt: string;
  /** 題名か本文が判定時点の写しと違う印 (updatedAt だけの変化では立たない)。 */
  readonly needsRejudge: boolean;
  readonly updatedAtChanged: boolean;
}

export interface ExternalIssueListDto {
  /** false = メンテナ環境ではない (一覧は空。画面は切り替えを出さない)。 */
  readonly enabled: boolean;
  readonly state: 'idle' | 'ok' | 'error';
  readonly fetchedAt: string | null;
  /** kind はサーバーが増やしうるので string で受ける。detail は gh の stderr を整えた文で、ローカルの読み手にだけ出す (逸脱表 3)。 */
  readonly error: { readonly kind: string; readonly detail: string } | null;
  readonly truncated: boolean;
  readonly skippedLines: number;
  readonly issues: readonly ExternalIssueDto[];
}

export function fetchExternalIssues(): Promise<ExternalIssueListDto> {
  return fetchJson<ExternalIssueListDto>(EXTERNAL_ISSUES_API_PATH);
}

/**
 * 「今すぐ確認」。サーバーはローカル直アクセスだけ受け、60 秒に 1 回まで (超えたら 429)。確認が失敗しても HTTP は 200 で、
 * 失敗は返る一覧の `state: 'error'` に出る。CSRF の検査が JSON の content-type を要るので、空の本文でも付ける。
 */
export function refreshExternalIssues(): Promise<ExternalIssueListDto> {
  return fetchJson<ExternalIssueListDto>(EXTERNAL_ISSUES_REFRESH_API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

/** 429 の本文の `retryAfterSeconds` (正の整数)。429 でない・本文が読めない・数でないときは undefined。 */
export function refreshWaitSeconds(error: unknown): number | undefined {
  if (!(error instanceof ApiError) || error.status !== 429 || error.body === undefined) return undefined;
  try {
    const value = (JSON.parse(error.body) as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
