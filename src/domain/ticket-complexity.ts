/**
 * bd メタデータのキー: `bdboard.complexity` = チケットの複雑度(自由文字列。
 * 現行の運用は low/med/high だが、パーサー自身は値の集合を検証しない —
 * `bdboard.model.<工程>` (ticket-model.ts) と同じ方針で、表示専用の値は
 * 想定外の入力もそのまま出す方が実態に近い。bdboard-p5l.18)。
 */
export const TICKET_COMPLEXITY_METADATA_KEY = 'bdboard.complexity';

/**
 * `bdboard.complexity` の値を取り出す。メタデータは外部入力なので、非文字列
 * (数値・null 等)や空文字/空白のみの値は「未記録」として undefined を返す。
 */
export function parseTicketComplexity(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const value = metadata?.[TICKET_COMPLEXITY_METADATA_KEY];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
