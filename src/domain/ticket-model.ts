/** bd メタデータのキー: `bdboard.model.<工程>` = <モデル名>。 */
export const TICKET_MODEL_METADATA_PREFIX = 'bdboard.model.';

export const KNOWN_STAGE_ORDER = [
  'implement',
  'test',
  'review',
  'check',
] as const;

export interface TicketModelRecord {
  /** 工程名。`bdboard.model.` を除いた部分（自由文字列）。 */
  readonly stage: string;
  /** モデル名。 */
  readonly model: string;
}

function sortTicketModelRecords(
  records: readonly TicketModelRecord[],
): TicketModelRecord[] {
  const knownOrder = new Map<string, number>(
    KNOWN_STAGE_ORDER.map((stage, index) => [stage, index]),
  );

  return [...records].sort((a, b) => {
    const aKnown = knownOrder.get(a.stage);
    const bKnown = knownOrder.get(b.stage);

    if (aKnown !== undefined && bKnown !== undefined) {
      return aKnown - bKnown;
    }
    if (aKnown !== undefined) {
      return -1;
    }
    if (bKnown !== undefined) {
      return 1;
    }
    return a.stage < b.stage ? -1 : a.stage > b.stage ? 1 : 0;
  });
}

export function parseTicketModelRecords(
  metadata: Readonly<Record<string, unknown>> | undefined,
): TicketModelRecord[] {
  if (metadata === undefined) {
    return [];
  }

  const records: TicketModelRecord[] = [];

  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(TICKET_MODEL_METADATA_PREFIX)) {
      continue;
    }

    const stage = key.slice(TICKET_MODEL_METADATA_PREFIX.length);
    if (stage.length === 0) {
      continue;
    }

    if (typeof value !== 'string') {
      continue;
    }

    const model = value.trim();
    if (model.length === 0) {
      continue;
    }

    records.push({ stage, model });
  }

  return sortTicketModelRecords(records);
}
