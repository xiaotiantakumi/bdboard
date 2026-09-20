export type PendingDecisionKind = 'gate' | 'ticket';

/**
 * respond() が実際に到達した種別。'unknown' は「bd show で種別を判定できなかった」
 * を表し、この場合は close も label remove も行わない(fail-safe)。
 */
export type ResolvedDecisionKind = PendingDecisionKind | 'unknown';

export interface RespondOutcome {
  readonly kind: ResolvedDecisionKind;
  readonly closed: boolean;
  /**
   * kind === 'ticket' のときだけ設定される。respond() が追加で resolve した、
   * このチケットをブロックしていた open な human gate の ID 一覧(bdboard-vy0h)。
   * 空配列は「ブロックしている human gate が無かった」ことを表す。
   */
  readonly resolvedGateIds?: readonly string[];
  /**
   * kind === 'gate' のときだけ設定される。この gate を resolve した結果、他に
   * ブロックしている open な human gate が残っていなかったために human ラベルを
   * 外した work ticket の ID 一覧(bdboard-giyt。bdboard-vy0h の逆方向)。他の
   * human gate がまだ残っているチケットのラベルは外さない。読み取りに失敗した
   * 場合は fail-soft でそのチケットをスキップする(gate 自体の close は既に成功
   * しているため、この清掃だけを理由に respond() 全体を失敗させない)。
   */
  readonly clearedHumanLabelTicketIds?: readonly string[];
  /**
   * kind === 'ticket' のときだけ設定される。このチケットをブロックしている open な
   * human gate が2件以上あり、どの gate への回答か特定できなかったために、どの gate も
   * resolve せず・human ラベルも外さなかった場合の、その gate ID 一覧(bdboard-q1k9)。
   * 1件以下の場合は resolvedGateIds 側で処理され、この項目は設定されない。
   */
  readonly ambiguousGateIds?: readonly string[];
}

export interface PendingDecisionOption {
  readonly label: string;
  readonly value: string;
}

export interface PendingDecision {
  readonly id: string;
  readonly kind: PendingDecisionKind;
  readonly question?: string;
  readonly options?: readonly PendingDecisionOption[];
  readonly allowFreeform: boolean;
}

export interface HumanDecisionsPort {
  listPendingDecisions(rootPath: string): Promise<readonly PendingDecision[]>;
  respond(
    rootPath: string,
    issueId: string,
    responseText: string,
  ): Promise<RespondOutcome>;
}
