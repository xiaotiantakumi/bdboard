export interface PendingDecisionOption {
  readonly label: string;
  readonly value: string;
}

export interface PendingDecision {
  readonly id: string;
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
  ): Promise<void>;
}
