import type { PrCheckStatus, PrState, PrStatus } from '../../domain/pr-link.js';

/**
 * 恒久化 (permanent) されたエントリの永続化用の形。bdboard-ye2p: terminal な
 * (merged/closed かつ checks 確定、または merged-pending の最大再試行後に
 * 恒久化した) 結果だけをサーバー再起動をまたいで残す。status は必ず非 null
 * (permanent になる経路はどちらも成功結果を伴うため)。
 *
 * pr-badge-status-cache.ts から型とバリデーションだけを切り出した (行数上限
 * 対応。挙動は変えていない)。infrastructure/fs/pr-badge-status-store.ts が
 * このファイルの読み書きの対象になる。
 */
export interface PersistedPrBadgeStatusEntry {
  readonly url: string;
  readonly status: PrStatus;
  readonly fetchedAt: number;
  readonly mergedPendingRetries: number;
}

const VALID_PR_STATES: readonly PrState[] = ['open', 'merged', 'closed'];
const VALID_PR_CHECK_STATUSES: readonly PrCheckStatus[] = ['pass', 'fail', 'pending', 'unknown'];

/**
 * 永続化ファイルから読み込んだ値を信用しすぎない防御的バリデーション。破損
 * ファイルや旧スキーマの残骸が混ざっていても、そのエントリだけを無視して
 * 起動を継続する (ファイル単位の try/catch は呼び出し側のストアが持つ)。
 */
export function isValidPersistedPrBadgeStatusEntry(
  entry: unknown,
): entry is PersistedPrBadgeStatusEntry {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const candidate = entry as Record<string, unknown>;
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) {
    return false;
  }
  if (typeof candidate.fetchedAt !== 'number' || !Number.isFinite(candidate.fetchedAt)) {
    return false;
  }
  if (
    typeof candidate.mergedPendingRetries !== 'number' ||
    !Number.isFinite(candidate.mergedPendingRetries) ||
    candidate.mergedPendingRetries < 0
  ) {
    return false;
  }
  const status = candidate.status;
  if (typeof status !== 'object' || status === null) {
    return false;
  }
  const statusCandidate = status as Record<string, unknown>;
  const state = statusCandidate.state;
  const checkStatus = statusCandidate.checkStatus;
  if (typeof state !== 'string' || !VALID_PR_STATES.includes(state as PrState)) {
    return false;
  }
  // permanent は merged/closed の結果でしか成立しない — open が混じっていたら
  // 破損とみなす。
  if (state === 'open') {
    return false;
  }
  if (
    typeof checkStatus !== 'string' ||
    !VALID_PR_CHECK_STATUSES.includes(checkStatus as PrCheckStatus)
  ) {
    return false;
  }
  return true;
}


/**
 * PrBadgeStatusCache の内部 Map 値の形。pr-badge-status-cache.ts から切り出した
 * (bdboard-ye2p, 行数上限対応)。
 */
export interface PrBadgeStatusCacheEntry {
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

export function isTerminalPrStatus(status: PrStatus | null): boolean {
  if (status === null) {
    return false;
  }
  return (
    (status.state === 'merged' || status.state === 'closed') && status.checkStatus !== 'pending'
  );
}

export function isMergedPendingStatus(status: PrStatus): boolean {
  return (
    (status.state === 'merged' || status.state === 'closed') && status.checkStatus === 'pending'
  );
}


/**
 * 起動時の初期化用: 永続化ストアから読んだ配列を検証しつつ Map へ変換する。
 * pr-badge-status-cache.ts のコンストラクタから切り出した (bdboard-ye2p, 行数上限)。
 */
export function buildInitialPrBadgeStatusEntries(
  initialEntries: readonly PersistedPrBadgeStatusEntry[] | undefined,
): Map<string, PrBadgeStatusCacheEntry> {
  const entries = new Map<string, PrBadgeStatusCacheEntry>();
  for (const entry of initialEntries ?? []) {
    if (!isValidPersistedPrBadgeStatusEntry(entry)) {
      continue;
    }
    entries.set(entry.url, {
      status: entry.status,
      fetchedAt: entry.fetchedAt,
      permanent: true,
      failureStreak: 0,
      mergedPendingRetries: entry.mergedPendingRetries,
    });
  }
  return entries;
}

/** 永続化対象 (permanent なエントリ) だけを取り出す。getTerminalEntries() から切り出した。 */
export function collectTerminalPrBadgeStatusEntries(
  entries: ReadonlyMap<string, PrBadgeStatusCacheEntry>,
): readonly PersistedPrBadgeStatusEntry[] {
  const result: PersistedPrBadgeStatusEntry[] = [];
  for (const [url, entry] of entries) {
    if (entry.permanent && entry.status !== null) {
      result.push({
        url,
        status: entry.status,
        fetchedAt: entry.fetchedAt,
        mergedPendingRetries: entry.mergedPendingRetries,
      });
    }
  }
  return result;
}
