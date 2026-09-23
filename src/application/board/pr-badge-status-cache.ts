import type { PrStatus } from '../../domain/pr-link.js';
import type { PrStatusResult } from '../ports/pr-status-reader.js';

/**
 * PrBadgeStatusCache — PR URL ごとの gh pr view 結果を TTL/恒久で保持する薄いキャッシュ。
 * get-pr-badges.ts から切り出した (bdboard-se3v: 挙動変更ついでの行数上限対応。関心の
 * 分割のみ、ロジックは1文字も変えていない)。
 */
interface PrBadgeStatusCacheEntry {
  readonly status: PrStatus | null;
  readonly fetchedAt: number;
  readonly permanent: boolean;
  /**
   * 連続で取得失敗 (rate-limit を除く。not-found/timeout/other) した回数。
   * 否定キャッシュの指数バックオフに使う (bdboard-7ln6 #3)。成功すると 0 に戻る。
   */
  readonly failureStreak: number;
  /**
   * merged/closed だが checks が pending のまま再取得した回数。しきい値
   * (mergedPendingMaxRetries) を超えたら、その時点の状態のまま恒久化する
   * (bdboard-7ln6 #4)。state が merged/closed+pending でなくなると 0 に戻る。
   */
  readonly mergedPendingRetries: number;
}

export interface PrBadgeStatusCacheOptions {
  readonly now?: () => number;
  /** 通常 (open PR 等) の TTL。既定 60秒。 */
  readonly ttlMs?: number;
  /** 否定キャッシュ (失敗) の指数バックオフの上限。既定 30分。 */
  readonly negativeCacheMaxMs?: number;
  /** merged/closed+pending を再取得するまでの TTL。既定 30分。 */
  readonly mergedPendingTtlMs?: number;
  /** merged/closed+pending を何回再取得したら恒久化するか。既定 3回。 */
  readonly mergedPendingMaxRetries?: number;
  /** rate-limit 検知時、最初にサーキットを開く時間。既定 15分。 */
  readonly circuitInitialCooldownMs?: number;
  /** rate-limit が連続したときのサーキット open 時間の上限。既定 1時間。 */
  readonly circuitMaxCooldownMs?: number;
  /** サーキットが open になった瞬間の警告ログ。未指定なら console.warn。 */
  readonly logWarn?: (message: string) => void;
}

const DEFAULT_STATUS_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_CACHE_MAX_MS = 30 * 60_000;
const DEFAULT_MERGED_PENDING_TTL_MS = 30 * 60_000;
const DEFAULT_MERGED_PENDING_MAX_RETRIES = 3;
const DEFAULT_CIRCUIT_INITIAL_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_CIRCUIT_MAX_COOLDOWN_MS = 60 * 60_000;

function isTerminalPrStatus(status: PrStatus | null): boolean {
  if (status === null) {
    return false;
  }
  return (
    (status.state === 'merged' || status.state === 'closed') && status.checkStatus !== 'pending'
  );
}

function isMergedPendingStatus(status: PrStatus): boolean {
  return (status.state === 'merged' || status.state === 'closed') && status.checkStatus === 'pending';
}

/**
 * PR URL ごとの gh pr view 結果を TTL/恒久で保持する薄いキャッシュ。
 *
 * bdboard-7ln6: gh の失敗を握りつぶして60秒TTLでしか覚えないと、rate limit
 * が続く間 board.changed のたびに全PRを撃ち直して rate limit とマシン負荷を
 * 食い潰す。このクラスは (1) rate-limit を検知したら一定時間ぜんぶの gh
 * 起動を止めるサーキットブレーカー、(2) URL単位の失敗の指数バックオフ否定
 * キャッシュ、(3) merged/closed+pending の長め TTL + 最大再試行後の恒久化、
 * (4) 同一 URL への同時リクエストの in-flight 共有、を一手に引き受ける。
 * routes.ts はこれまで通り `new PrBadgeStatusCache()` を引数なしで生成すれば
 * 全部の既定値が効く (routes.ts 無変更で直す方針, bdboard-7ln6 の注意書き)。
 */
export class PrBadgeStatusCache {
  private readonly entries = new Map<string, PrBadgeStatusCacheEntry>();
  private readonly inFlight = new Map<string, Promise<PrStatusResult>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly negativeCacheMaxMs: number;
  private readonly mergedPendingTtlMs: number;
  private readonly mergedPendingMaxRetries: number;
  private readonly circuitInitialCooldownMs: number;
  private readonly circuitMaxCooldownMs: number;
  private readonly logWarn: (message: string) => void;
  private circuitOpenUntil: number | null = null;
  private nextCircuitCooldownMs: number;

  constructor(options?: PrBadgeStatusCacheOptions) {
    this.now = options?.now ?? (() => Date.now());
    this.ttlMs = options?.ttlMs ?? DEFAULT_STATUS_TTL_MS;
    this.negativeCacheMaxMs = options?.negativeCacheMaxMs ?? DEFAULT_NEGATIVE_CACHE_MAX_MS;
    this.mergedPendingTtlMs = options?.mergedPendingTtlMs ?? DEFAULT_MERGED_PENDING_TTL_MS;
    this.mergedPendingMaxRetries =
      options?.mergedPendingMaxRetries ?? DEFAULT_MERGED_PENDING_MAX_RETRIES;
    this.circuitInitialCooldownMs =
      options?.circuitInitialCooldownMs ?? DEFAULT_CIRCUIT_INITIAL_COOLDOWN_MS;
    this.circuitMaxCooldownMs = options?.circuitMaxCooldownMs ?? DEFAULT_CIRCUIT_MAX_COOLDOWN_MS;
    this.logWarn = options?.logWarn ?? ((message: string) => console.warn(message));
    this.nextCircuitCooldownMs = this.circuitInitialCooldownMs;
  }

  get(url: string): PrStatus | null | undefined {
    const entry = this.entries.get(url);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.permanent) {
      return entry.status;
    }
    if (this.now() - entry.fetchedAt < this.computeTtl(entry)) {
      return entry.status;
    }
    // 期限切れでも entries からは消さない — mergedPendingRetries/failureStreak を
    // 失うと「最大N回で恒久化」が二度と成立しなくなる (期限切れのたびにカウンタが
    // 0 に戻ってしまう)。表示に使う値は undefined を返すだけで十分。
    return undefined;
  }

  private computeTtl(entry: PrBadgeStatusCacheEntry): number {
    if (entry.status === null) {
      const backoff = this.ttlMs * 2 ** Math.max(0, entry.failureStreak - 1);
      return Math.min(backoff, this.negativeCacheMaxMs);
    }
    if (isMergedPendingStatus(entry.status)) {
      return this.mergedPendingTtlMs;
    }
    return this.ttlMs;
  }

  /** true の間、fetchStatus は新規に gh を起動しない (bdboard-7ln6 #2)。 */
  isCircuitOpen(): boolean {
    return this.circuitOpenUntil !== null && this.now() < this.circuitOpenUntil;
  }

  isInFlight(url: string): boolean {
    return this.inFlight.has(url);
  }

  /**
   * url の状態取得を行う。同一 url が既に取得中なら新しく gh を起動せず、その
   * Promise を共有する (in-flight 共有, bdboard-7ln6 #6)。取得の起点になった
   * 呼び出しだけが結果を記録する (キャッシュ更新 + サーキットブレーカー判定)。
   * fetcher が例外を投げた場合は記録しない (次回すぐ再試行できるよう、否定
   * キャッシュも書き込まない — 例外時は書き込まない既存契約を維持する)。
   *
   * 呼び出し元は fetchStatus を呼ぶ前に isCircuitOpen() を確認すること — この
   * メソッド自体はサーキット状態を見ない (呼び出し元が起動可否の予算/計測と
   * まとめて判断できるようにするため)。
   */
  fetchStatus(
    url: string,
    fetcher: () => Promise<PrStatusResult>,
  ): { readonly promise: Promise<PrStatusResult>; readonly launched: boolean } {
    const existing = this.inFlight.get(url);
    if (existing !== undefined) {
      return { promise: existing, launched: false };
    }
    const promise = fetcher()
      .then((result) => {
        this.recordResult(url, result);
        return result;
      })
      .finally(() => {
        this.inFlight.delete(url);
      });
    this.inFlight.set(url, promise);
    return { promise, launched: true };
  }

  private recordResult(url: string, result: PrStatusResult): void {
    if (result.status !== null) {
      this.recordSuccess(url, result.status);
      // クールダウン中 (isCircuitOpen()===true) なら閉じない。並行起動された
      // 別URLの成功が、たまたま rate-limit トリップの直後に届いただけかも
      // しれず、それでブレーカーを即リセットしてしまうと再試行間隔の一元管理
      // という目的そのものが壊れる (bdboard-v538)。cooldown が自然に経過した
      // 後の成功 (half-open probe) でのみ閉じ、そこで cooldown 段階もリセット
      // する。
      if (!this.isCircuitOpen()) {
        this.closeCircuit();
      }
      return;
    }
    if (result.reason === 'rate-limit') {
      // URL単位のキャッシュは書かない — サーキットブレーカーが再試行間隔を
      // 一元管理する。ブレーカーが閉じれば、このURLもすぐ再試行対象になる。
      this.tripCircuit();
      return;
    }
    this.recordFailure(url);
  }

  private recordSuccess(url: string, status: PrStatus): void {
    if (isTerminalPrStatus(status)) {
      this.entries.set(url, {
        status,
        fetchedAt: this.now(),
        permanent: true,
        failureStreak: 0,
        mergedPendingRetries: 0,
      });
      return;
    }
    if (isMergedPendingStatus(status)) {
      const previous = this.entries.get(url);
      const retries = (previous?.mergedPendingRetries ?? 0) + 1;
      this.entries.set(url, {
        status,
        fetchedAt: this.now(),
        permanent: retries >= this.mergedPendingMaxRetries,
        failureStreak: 0,
        mergedPendingRetries: retries,
      });
      return;
    }
    this.entries.set(url, {
      status,
      fetchedAt: this.now(),
      permanent: false,
      failureStreak: 0,
      mergedPendingRetries: 0,
    });
  }

  private recordFailure(url: string): void {
    const previous = this.entries.get(url);
    this.entries.set(url, {
      status: null,
      fetchedAt: this.now(),
      permanent: false,
      failureStreak: (previous?.failureStreak ?? 0) + 1,
      mergedPendingRetries: previous?.mergedPendingRetries ?? 0,
    });
  }

  private tripCircuit(): void {
    if (this.isCircuitOpen()) {
      // 既に open (ほぼ同時に走っていた他の URL が先に開いた) — 二重ログ・
      // 二重バックオフを避けるため何もしない。
      return;
    }
    const cooldownMs = this.nextCircuitCooldownMs;
    this.circuitOpenUntil = this.now() + cooldownMs;
    this.nextCircuitCooldownMs = Math.min(cooldownMs * 2, this.circuitMaxCooldownMs);
    this.logWarn(
      `[pr-links] gh reported a rate limit; pausing all gh pr view calls for ${Math.round(
        cooldownMs / 1000,
      )}s.`,
    );
  }

  private closeCircuit(): void {
    this.circuitOpenUntil = null;
    this.nextCircuitCooldownMs = this.circuitInitialCooldownMs;
  }
}
