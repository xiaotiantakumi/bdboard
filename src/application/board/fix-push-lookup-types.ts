import { findImplementModel } from '../../domain/ticket-model.js';
import type { Ticket } from '../../domain/ticket.js';

/**
 * チケット1件ぶんの「修正 push 回数」の引き当て結果 (bdboard-p5l.27)。
 *
 * - known: 取得できた値 (0 は「PR 作成後の追加コミットなし」という確定値)。
 * - unknown + pending=false: 確定した「不明」(PR のコメントが無い / PR URL が無い /
 *   gh が応答したが日時が読めなかった / 直近の gh 取得が失敗して否定キャッシュ中 /
 *   古い恒久エントリの取り直しが失敗した)。
 * - unknown + pending=true: まだ取れていないだけ (PR URL の解決前・gh の取得前・古い
 *   永続エントリの取り直し待ち)。先読みが進めば known / 確定 unknown に変わりうる。
 */
export type FixPushLookupResult =
  | { readonly kind: 'known'; readonly count: number }
  | { readonly kind: 'unknown'; readonly pending: boolean };

/** 同期・副作用なし (gh も bd も起動しない) でキャッシュだけを読む引き当て関数。 */
export type FixPushLookup = (ticket: Ticket) => FixPushLookupResult;

/**
 * 統計 (複雑度 × 実装モデル × 修正 push 回数) の対象にするチケットか。
 *
 * クローズ済みで、`bdboard.complexity` か `bdboard.model.implement` の少なくとも一方が
 * 記録されているもの。どちらも未記録のチケットは行に含めず件数だけ別に数える
 * (complexity-model-stats.ts)。PR の引き当て・先読みもこの対象だけに限るので、
 * 過去の全クローズ済みチケットぶんの gh 起動は発生しない。
 */
export function isFixPushStatsTarget(ticket: Ticket): boolean {
  if (ticket.closedAt === undefined) {
    return false;
  }
  return ticket.complexity !== undefined || findImplementModel(ticket.models) !== undefined;
}
