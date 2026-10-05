/**
 * 届いた issue を定期的に確かめるときの頻度の規則 (bdboard-4y8q.9.4、docs/ISSUE-REPORTING.md 8節)。
 * IO を持たない定数と純粋関数だけ。タイマーは `external-issue-scheduler.ts`、gh の呼び出しの枠は `call-budget.ts`。
 */

/** 確かめる間隔の既定 (15 分)。環境変数 BDBOARD_EXTERNAL_ISSUES_INTERVAL_MS で変えられる。 */
export const EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS = 900_000;

/** 確かめる間隔の下限 (5 分)。これより短い指定は丸める。 */
export const EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS = 300_000;

/**
 * 確かめる間隔の上限 (24 時間)。Node の setTimeout は 2^31-1 ms (約 24.8 日) を超えると 1 ms で発火してしまうので、
 * それより十分手前で丸める。
 */
export const EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS = 86_400_000;

/** 最初の確認は起動の 60 秒後 (起動直後の読み込みと重ねない)。 */
export const EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS = 60_000;

/** rate-limited / failed が続いたときに間隔を延ばす上限 (1 時間)。 */
export const EXTERNAL_ISSUE_POLL_BACKOFF_CAP_MS = 3_600_000;

/** 手動の refresh は、この間隔に 1 回まで。 */
export const EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS = 60_000;

/**
 * gh の呼び出し (`gh api` 1 回 = 1 ページ) の上限。どの 1 時間の窓でも、定期の確認・手動の refresh・
 * ページ送りを合わせて、これを超えて gh を起動しない。数え方と根拠は docs/ISSUE-REPORTING.md 8節。
 */
export const EXTERNAL_ISSUE_GH_CALLS_PER_HOUR = 12;

/** 上の上限を数える窓 (1 時間)。 */
export const EXTERNAL_ISSUE_GH_CALL_WINDOW_MS = 3_600_000;

/** 1 回の確認で読むページの上限。1 回の確認が起動する gh の最大の回数でもある (1 ページ = 100 件)。 */
export const EXTERNAL_ISSUE_GH_MAX_PAGES = 3;

/**
 * 環境変数から読んだ間隔 (ミリ秒) を、使える範囲に丸める。数でないものは既定、0・負の値は下限に丸める
 * (間隔を「止める」指定は用意していない)。
 */
export function resolveExternalIssuePollIntervalMs(requestedMs: number): number {
  if (!Number.isFinite(requestedMs)) return EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS;
  const whole = Math.trunc(requestedMs);
  return Math.min(EXTERNAL_ISSUE_POLL_MAX_INTERVAL_MS, Math.max(EXTERNAL_ISSUE_POLL_MIN_INTERVAL_MS, whole));
}

export interface NextPollDelayInput {
  /** 丸め済みの通常の間隔。 */
  readonly baseMs: number;
  /** 直前に使った間隔 (延ばしている途中なら、延ばした後の値)。 */
  readonly previousMs: number;
  /** 直前の確認の結果。成功なら null、止まったならその種類 (`ExternalIssueListErrorKind`)。 */
  readonly errorKind: string | null;
}

/**
 * 次の確認までの間隔。GitHub の側の都合 (`rate-limited`) か時間切れなど (`failed`) で止まったときだけ、直前の間隔を
 * 倍にして 1 時間まで延ばす (通常の間隔が 1 時間より長いときは、その間隔が上限で、失敗のほうが短くなることはない)。
 * 成功と、手元の設定の問題 (`gh-missing`・`gh-unauthenticated`・`bd-failed`・`storage-failed`・`unexpected`) は通常の間隔に戻す:
 * 後者は待っても直らず、GitHub への負荷でもないので、延ばす理由がない。
 */
export function nextExternalIssuePollDelayMs(input: NextPollDelayInput): number {
  const backsOff = input.errorKind === 'rate-limited' || input.errorKind === 'failed';
  if (!backsOff) return input.baseMs;
  const cap = Math.max(input.baseMs, EXTERNAL_ISSUE_POLL_BACKOFF_CAP_MS);
  return Math.min(cap, input.previousMs * 2);
}
