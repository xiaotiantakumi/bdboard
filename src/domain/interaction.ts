export interface InteractionRecord {
  readonly id: string;
  readonly at: Date;
  readonly actor: string;
  readonly ticketId: string;
  readonly field: string;
  readonly oldValue?: string;
  readonly newValue?: string;
  readonly reason?: string;
}
