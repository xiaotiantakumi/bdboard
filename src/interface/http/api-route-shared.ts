import type { GetBoardDeps } from '../../application/board/get-board.js';
import {
  DEFAULT_LIVENESS_THRESHOLDS,
  type LivenessThresholds,
} from '../../domain/liveness.js';
import type { CachedProject } from '../../application/ports/board-cache.js';
import type { InFlightOverlap } from '../../domain/in-flight-overlap.js';
import { parseClampedIntQueryParam } from './parse-clamped-int-query-param.js';
import type { ApiDeps } from './routes.js';

/**
 * ここに置くのは複数のルートグループ (board / stats / hygiene / tickets 読み取り /
 * sessions 等) から共有で使われるヘルパーだけ。1グループでしか使わないヘルパーは
 * そのグループのルートファイルに置く (bdboard-sso1.1: routes.ts 分割)。
 */

const ACTIVITY_DEFAULT_LIMIT = 100;
const ACTIVITY_MIN_LIMIT = 1;
const ACTIVITY_MAX_LIMIT = 200;

// /api/activity (board-routes.ts) と /api/tickets/:id/timeline (ticket-read-routes.ts)
// の両方が使う。
export function parseActivityLimit(raw: string | undefined): number {
  return parseClampedIntQueryParam(raw, {
    min: ACTIVITY_MIN_LIMIT,
    max: ACTIVITY_MAX_LIMIT,
    defaultValue: ACTIVITY_DEFAULT_LIMIT,
  });
}

export function parseProjectIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }

  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (ids.length === 0) {
    return undefined;
  }

  return ids;
}

/*
 * DTO 変換は liveness 閾値を必須で受け取る (bdboard-5kz2)。getBoardThresholds は
 * 任意の依存なので、未注入のときにどの値へ落ちるかをここ1箇所で明示する。
 * 各ハンドラで `?? DEFAULT_LIVENESS_THRESHOLDS` を書き散らすと、渡し忘れと
 * 「既定でよい」の区別がまた付かなくなる。
 */
export async function resolveLivenessThresholds(
  deps: ApiDeps,
): Promise<LivenessThresholds> {
  const thresholds = await deps.getBoardThresholds?.();
  return thresholds?.livenessThresholds ?? DEFAULT_LIVENESS_THRESHOLDS;
}

export async function buildGetBoardDeps(deps: ApiDeps): Promise<GetBoardDeps> {
  const thresholds = await deps.getBoardThresholds?.();
  const sessions = deps.sessions?.();
  const links = deps.links?.();
  return {
    cache: deps.cache,
    now: deps.now(),
    ...(sessions !== undefined ? { sessions } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(thresholds !== undefined
      ? {
          stalledThresholds: thresholds.stalledThresholds,
          livenessThresholds: thresholds.livenessThresholds,
        }
      : {}),
  };
}

/**
 * 着手中重複の再計算を抑えるメモの寿命。
 *
 * /api/hygiene と詳細パネルの /api/tickets/:id/in-flight-overlaps は同じ計算をする。
 * 盤面を開いたままチケットを次々に開くと、その都度 worktree ぶんの git が走るので、
 * プロジェクト集合が同じ呼び出しは短時間だけ結果を使い回す。30 秒あれば
 * 「Hygiene を見る → 気になったチケットを開く」がまとめて 1 回で済み、それを超えれば
 * 作業中の編集が反映される程度には短い。
 *
 * ただし bd 側の変化 (他チケットの close / reopen で着手中 worktree 集合が変わる) は
 * 30 秒を待たない。メモには計算時のキャッシュ世代 (fingerprint + fetchedAt) を持たせ、
 * どれかのプロジェクトが再取得されていたら使わない (bdboard-3tw.162)。再取得は
 * board.changed の refreshed と同じ条件なので、クライアントが board.changed で
 * invalidate した直後の再取得に古い重複を返さずに済む。EventHub を購読しないのは、
 * 購読者数が ai-quota プローブの要否判定に使われているため (bdboard-uopj)。
 * worktree の追加・削除やファイル編集は bd に現れないので、従来どおり寿命任せ。
 */
const IN_FLIGHT_OVERLAP_MEMO_MS = 30_000;

interface InFlightOverlapMemoEntry {
  readonly expiresAt: number;
  /** 計算時点のキャッシュ世代。inFlightOverlapGeneration の戻り */
  readonly generation: string;
  readonly result: Promise<readonly InFlightOverlap[]>;
}

/**
 * プロジェクト群のキャッシュ世代。refreshProjects は再取得したプロジェクトだけを
 * fetchedAt = now で putProject し直すので、fetchedAt が変われば bd が変わったとみなせる。
 * fingerprint も入れて、同じ時刻に書き直された場合も取りこぼさない。
 */
function inFlightOverlapGeneration(entries: readonly CachedProject[]): string {
  return entries
    .map((entry) =>
      [entry.project.id, entry.fingerprint, String(entry.fetchedAt.getTime())].join('\u0001'),
    )
    .sort()
    .join('\u0000');
}

export interface InFlightOverlapMemo {
  /** 生きているメモがあれば返す。無ければ undefined (計算はしない) */
  readonly peekInFlightOverlaps: (
    entries: readonly CachedProject[],
  ) => Promise<readonly InFlightOverlap[]> | undefined;
  readonly memoizedInFlightOverlaps: (
    entries: readonly CachedProject[],
    compute: () => Promise<readonly InFlightOverlap[]>,
  ) => Promise<readonly InFlightOverlap[]>;
}

/**
 * /api/hygiene (hygiene-status-routes.ts, bdboard-sso1.61 で hygiene-routes.ts から
 * 分割) と /api/tickets/:id/in-flight-overlaps
 * (ticket-read-routes.ts) の両方が同じメモを共有する必要がある (bdboard-sso1.1)。
 * createApiRoutes の呼び出しごとに 1 個作り、両方のルートグループへ渡す。
 */
export function createInFlightOverlapMemo(): InFlightOverlapMemo {
  const inFlightOverlapMemo = new Map<string, InFlightOverlapMemoEntry>();

  /**
   * 同じプロジェクト集合に対する着手中重複の計算を、IN_FLIGHT_OVERLAP_MEMO_MS だけ
   * 共有する。キャッシュ世代が変わったメモは使わず、同じキーで上書きする (キーは
   * プロジェクト集合のままなのでメモが世代ごとに増えていくことはない)。
   * 失敗した Promise は残さない (次の呼び出しでやり直す)。
   */
  const inFlightOverlapMemoKey = (entries: readonly CachedProject[]): string =>
    entries
      .map((entry) => entry.project.id)
      .sort()
      .join('\u0000');

  /** 期限内かつ同じキャッシュ世代のメモだけを返す */
  const liveInFlightOverlapMemo = (
    entries: readonly CachedProject[],
    now: number,
  ): InFlightOverlapMemoEntry | undefined => {
    const cached = inFlightOverlapMemo.get(inFlightOverlapMemoKey(entries));
    return cached !== undefined &&
      cached.expiresAt > now &&
      cached.generation === inFlightOverlapGeneration(entries)
      ? cached
      : undefined;
  };

  /** 生きているメモがあれば返す。無ければ undefined (計算はしない) */
  const peekInFlightOverlaps = (
    entries: readonly CachedProject[],
  ): Promise<readonly InFlightOverlap[]> | undefined =>
    liveInFlightOverlapMemo(entries, Date.now())?.result;

  const memoizedInFlightOverlaps = (
    entries: readonly CachedProject[],
    compute: () => Promise<readonly InFlightOverlap[]>,
  ): Promise<readonly InFlightOverlap[]> => {
    const key = inFlightOverlapMemoKey(entries);
    const now = Date.now();
    const cached = liveInFlightOverlapMemo(entries, now);
    if (cached !== undefined) {
      return cached.result;
    }

    const result = compute();
    inFlightOverlapMemo.set(key, {
      expiresAt: now + IN_FLIGHT_OVERLAP_MEMO_MS,
      generation: inFlightOverlapGeneration(entries),
      result,
    });
    result.catch(() => {
      const current = inFlightOverlapMemo.get(key);
      if (current?.result === result) {
        inFlightOverlapMemo.delete(key);
      }
    });
    return result;
  };

  return { peekInFlightOverlaps, memoizedInFlightOverlaps };
}
