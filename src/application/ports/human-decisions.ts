export type PendingDecisionKind = 'gate' | 'ticket';

/**
 * respond() が実際に到達した種別。'unknown' は「bd show で種別を判定できなかった」
 * を表し、この場合は close も label remove も行わない(fail-safe)。
 */
export type ResolvedDecisionKind = PendingDecisionKind | 'unknown';

export interface RespondOutcome {
  readonly kind: ResolvedDecisionKind;
  readonly closed: boolean;
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
