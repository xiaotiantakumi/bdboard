import { fetchJson } from './http';

export interface PendingDecisionDto {
  id: string;
  kind: 'gate' | 'ticket';
  projectId: string;
  question?: string;
  options?: { label: string; value: string }[];
  allowFreeform: boolean;
}

export interface TicketDecisionOutcome {
  kind: 'gate' | 'ticket' | 'unknown';
  closed: boolean;
  /**
   * kind === 'ticket' かつ closed === false のときだけ設定されうる
   * (bdboard-q1k9 / bdboard-v78e)。このチケットをブロックしている open な human gate
   * が2件以上あり、どの gate への回答か特定できなかったために、どの gate も resolve
   * せず・human ラベルも外さなかった場合の gate ID 一覧。mapTicketDecisionOutcome が
   * この不変条件(kind/closed の組み合わせ、配列の非空性、全要素が string であること)
   * を強制しているため、設定されているときは必ず1件以上の string を含む
   * (resolvedGateIds と異なり、空配列を意味のある値として返すことはない — 1件も
   * 無ければこのフィールド自体が省略される)。UI 側はこれが設定されているときに
   * 「個別に回答してください」という案内を出し、closed: false の通常の
   * 「確認待ちから外れました」メッセージは出さない(実際には何も変わっていないため)。
   */
  ambiguousGateIds?: string[];
  /**
   * kind や closed を問わず設定されうる(ticket 回答で兄弟チケットの human ラベルを
   * 外した場合、または gate に直接回答してそれがブロックしていた作業チケットの
   * human ラベルを外した場合)。1件も無ければこのフィールド自体が省略される。
   */
  clearedHumanLabelTicketIds?: string[];
}

export function fetchPendingDecisions(): Promise<PendingDecisionDto[]> {
  return fetchJson<PendingDecisionDto[]>('/api/tickets/pending-decisions');
}

// 応答が読めなかったときの既定は 'unknown'。'ticket' に倒すと UI が
// 「確認待ちから外れ、次の更新で通常のレーンに戻ります」と、クライアントには
// 裏付けられない状態を断言してしまう。サーバー側の respond() が判定不能を
// close も label 剥がしもせず 'unknown' で返すのと同じ fail-safe を、
// 応答が壊れている場合にも通す (bdboard-bh48 レビュー指摘)。
function mapTicketDecisionOutcome(raw: unknown): TicketDecisionOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'unknown', closed: false };
  }
  const outcome = (raw as { outcome?: unknown }).outcome;
  if (typeof outcome !== 'object' || outcome === null) {
    return { kind: 'unknown', closed: false };
  }
  const kind = (outcome as { kind?: unknown }).kind;
  const closed = (outcome as { closed?: unknown }).closed;
  const normalizedKind = kind === 'gate' ? 'gate' : kind === 'ticket' ? 'ticket' : 'unknown';
  const normalizedClosed = closed === true;
  // bdboard-v78e レビュー指摘: respond() の実装上 ambiguousGateIds は
  // kind==='ticket' かつ closed:false のときしか立たない(isAmbiguousTicketAnswer が
  // 早期 returnするため resolvedGateIds/closed:true とは排他)。ここでその不変条件を
  // 明示的に強制しておく — サーバーが将来おかしな組み合わせを返しても、UI 側の分岐が
  // それを前提にしすぎて「解決済みのゲートを未解決と誤表示する」ような事故を防ぐため。
  // 配列の中身は全要素が string のときだけ信頼する(bdboard-bh48 と同じ fail-safe:
  // 一部だけ不正な要素を黙って間引くより、丸ごと信用しないほうが安全)。空配列は
  // respond() が絶対に返さない(下のコメント参照)が、念のため長さ0も弾く。
  const rawAmbiguousGateIds = (outcome as { ambiguousGateIds?: unknown }).ambiguousGateIds;
  const ambiguousGateIds =
    normalizedKind === 'ticket' &&
    !normalizedClosed &&
    Array.isArray(rawAmbiguousGateIds) &&
    rawAmbiguousGateIds.length > 0 &&
    rawAmbiguousGateIds.every((entry): entry is string => typeof entry === 'string')
      ? rawAmbiguousGateIds
      : undefined;
  const rawClearedHumanLabelTicketIds =
    (outcome as { clearedHumanLabelTicketIds?: unknown }).clearedHumanLabelTicketIds;
  const clearedHumanLabelTicketIds =
    Array.isArray(rawClearedHumanLabelTicketIds) &&
    rawClearedHumanLabelTicketIds.length > 0 &&
    rawClearedHumanLabelTicketIds.every((entry): entry is string => typeof entry === 'string')
      ? rawClearedHumanLabelTicketIds
      : undefined;
  return {
    kind: normalizedKind,
    closed: normalizedClosed,
    ...(ambiguousGateIds !== undefined ? { ambiguousGateIds } : {}),
    ...(clearedHumanLabelTicketIds !== undefined ? { clearedHumanLabelTicketIds } : {}),
  };
}

export function postTicketDecision(
  id: string,
  body: { choice?: string; freeform?: string },
): Promise<TicketDecisionOutcome> {
  return fetchJson<{
    ok: true;
    outcome?: {
      kind?: string;
      closed?: boolean;
      ambiguousGateIds?: string[];
      clearedHumanLabelTicketIds?: string[];
    };
  }>(`/api/tickets/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((data) => mapTicketDecisionOutcome(data));
}
