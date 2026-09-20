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
   * kind === 'gate' または kind === 'ticket' のときに設定されうる。resolve した
   * gate(kind === 'gate' なら回答対象の gate 自身、kind === 'ticket' なら
   * resolvedGateIds で resolve した gate)がブロックしていた work ticket のうち、
   * 他に何もブロックしていなかったために human ラベルを外した ID 一覧
   * (bdboard-giyt: gate→ticket 方向。bdboard-ixx9: ticket→gate 方向、同じ gate が
   * 複数チケットをブロックしていた場合の兄弟チケット。「回答対象自身を除いて」は
   * kind === 'ticket' の場合のみ意味を持つ — gate は自分自身の dependents には
   * 現れないため kind === 'gate' では自明)。他の open な human gate がまだ残って
   * いる、または standalone な decision_question(bdboard-mw8y)を記録している
   * チケットのラベルは外さない。読み取りに失敗した場合は fail-soft でそのチケットを
   * スキップする(gate の close/resolve 自体は既に成功しているため、この清掃だけを
   * 理由に respond() 全体を失敗させない)。resolvedGateIds と異なり、1件も外さな
   * かった場合はこの項目自体を設定しない(空配列は返さない)。
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
