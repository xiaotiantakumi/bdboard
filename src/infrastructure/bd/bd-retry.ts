import { BdError } from '../../application/ports/issue-repository.js';

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 1_500;
const DEFAULT_JITTER_RATIO = 0.3;

export interface RetryOptions {
  /** 初回試行後に許容する追加リトライ回数(既定 2 = 最大3試行)。 */
  readonly retries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** 指数バックオフに加える乱数ジッターの比率(0〜1)。同時失敗した複数プロセスが
   *  そろって再試行し再度衝突する thundering herd を避けるため。 */
  readonly jitterRatio?: number;
  /** テスト用の差し替えフック。既定は実 setTimeout ベースの待機。 */
  readonly sleep?: (delayMs: number) => Promise<void>;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function computeDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = capped * jitterRatio * Math.random();
  return capped + jitter;
}

/**
 * 汎用の限定リトライ + バックオフ。`isRetryable` が true を返したエラーだけを
 * 対象に、指数バックオフ(+ジッター)を挟みながら再試行する。それ以外のエラーは
 * 初回失敗でそのまま投げ直す。
 *
 * 呼び出し元が満たすべき前提: `operation` は **冪等**であること
 * (同じ結果に収束する再実行が安全であること)。このモジュール自体は
 * 冪等性を検証しないので、書き込み系コマンドに適用する場合は呼び出し元で
 * 個別に根拠を確認してから使うこと(bdboard-3tj)。
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) {
        throw error;
      }
      await sleep(computeDelayMs(attempt, baseDelayMs, maxDelayMs, jitterRatio));
      attempt += 1;
    }
  }
}

/** `BdError` かつ `kind === 'lock-contention'` のときだけ true。 */
export function isLockContentionError(error: unknown): boolean {
  return error instanceof BdError && error.kind === 'lock-contention';
}

/**
 * `BdError` かつ `kind === 'timeout'` のときだけ true。NodeCommandRunner の
 * timeoutMs 経過による SIGTERM/SIGKILL を受けて bd が context を cancel した
 * ケース(bdboard-vpt3。stderr に "context canceled" 等が出る)。負荷が高い
 * 時間帯に他プロジェクトの bd 読み取りで断続的に観測される。
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof BdError && error.kind === 'timeout';
}

/** `isLockContentionError` または `isTimeoutError`。 */
export function isTransientReadError(error: unknown): boolean {
  return isLockContentionError(error) || isTimeoutError(error);
}

// timeout 分類の1試行は最大 timeoutMs(既定30秒)かかりうる。lock-contention と
// 同じ retries:2 を流用すると最悪 3 試行 x 30秒 = 90秒 HTTP レスポンスを止め
// かねない(/api/hygiene は同期的にこれらを呼ぶ)。retries:1(最大2試行、
// 最悪でも約60秒)に抑える(bdboard-vpt3)。
const DEFAULT_TRANSIENT_READ_RETRIES = 1;

/**
 * embedded dolt の flock(プロセス単位の排他ロック)由来と分類された
 * `lock-contention` エラーに対する短期リトライ。ロックはプロセス終了で自動解放
 * されるため、数百ms〜数秒待てば空く可能性が高いという前提の短期的緩和策
 * (根本原因調査: bdboard-3tw.146。恒久対策のsql-serverモード移行は別チケット)。
 *
 * **読み取り専用コマンド(list/show/comments等)にのみ使うこと。** bd 自体は
 * 書き込みコマンドの冪等性を保証していないため、`bd comment` のような追記系は
 * 絶対にここへ通さない — 二重実行(コメント二重投稿等)のリスクがある。
 * `bd update --set-metadata`/`--unset-metadata` のように「同じ値へのSET」で
 * 結果が収束する明確に冪等な書き込みは例外的に対象へ含めてよいが、その場合は
 * 呼び出し元に根拠を明記すること。
 */
export function withLockContentionRetry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  return withRetry(operation, isLockContentionError, options);
}

/**
 * `withLockContentionRetry` に加えて `timeout`(bdboard-vpt3: 負荷が高い時間帯に
 * 他プロジェクトの bd 読み取りが断続的に context canceled でタイムアウトする件)
 * も短期リトライの対象にする。読み取り専用コマンド限定の前提は
 * `withLockContentionRetry` と同じ。既定 retries は 1(timeout 1試行が
 * timeoutMs 分かかりうるため、lock-contention 用の既定 2 より控えめ)。
 */
export function withTransientReadRetry<T>(
  operation: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  return withRetry(operation, isTransientReadError, {
    retries: DEFAULT_TRANSIENT_READ_RETRIES,
    ...options,
  });
}
