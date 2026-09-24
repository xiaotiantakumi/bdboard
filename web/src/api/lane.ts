// bdboard-a8e6: board.ts と tickets-read.ts の相互 Lane 型依存を解消するため、レーン定義を切り出した。
// 列の表示順は「着手可能 → 進行中 → 確認待ち → ブロック → 完了」(bdboard-662)。この配列の
// 並びがそのままレーン列の表示順になる(components/board/boardLanesHelpers.ts の
// visibleLanes 参照)。サーバー側の
// LANES (src/domain/readiness.ts)と値の集合を必ず一致させること(web は src を import
// できないため、独立に2箇所で定義している)。
//
// bdboard-662: 「保留(deferred)」は独立レーンを持たず「ブロック(blocked)」に表示統合される。
// bd 上の status は 'deferred' のまま変更しない(defer_until の情報や bd ready の除外挙動を
// 壊さないため)。カードの deferDays/deferUrgency 表示は lane==='blocked' の条件で維持する
// (LaneColumn.tsx の showDeferCountdown 参照)。
export const LANES = ['ready', 'in_progress', 'awaiting_human', 'blocked', 'done'] as const;
export type Lane = (typeof LANES)[number];

export const LANE_LABELS: Record<Lane, string> = {
  ready: '着手可能',
  in_progress: '進行中',
  awaiting_human: '確認待ち',
  blocked: 'ブロック',
  done: '完了',
};
