export interface MergeSlotRawSignal {
  readonly status: string;
  readonly holder: string | null;
  readonly updatedAt: string;
}

export interface MergeSlotStatus {
  readonly projectId: string;
  readonly present: boolean;
  readonly held: boolean;
  readonly holder: string | null;
  readonly heldSinceIso: string | null;
  readonly heldForMs: number;
  readonly isLongHeld: boolean;
}

export interface MergeSlotThresholds {
  readonly longHoldAfterMs: number;
}

export const DEFAULT_MERGE_SLOT_THRESHOLDS: MergeSlotThresholds = {
  longHoldAfterMs: 30 * 60_000,
};

function parseIsoMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function evaluateMergeSlotStatus(
  projectId: string,
  signal: MergeSlotRawSignal | null,
  now: Date,
  thresholds: MergeSlotThresholds = DEFAULT_MERGE_SLOT_THRESHOLDS,
): MergeSlotStatus {
  if (signal === null) {
    return {
      projectId,
      present: false,
      held: false,
      holder: null,
      heldSinceIso: null,
      heldForMs: 0,
      isLongHeld: false,
    };
  }

  if (signal.status !== 'in_progress') {
    return {
      projectId,
      present: true,
      held: false,
      holder: null,
      heldSinceIso: null,
      heldForMs: 0,
      isLongHeld: false,
    };
  }

  const updatedMs = parseIsoMs(signal.updatedAt);
  const heldForMs =
    updatedMs === null ? 0 : Math.max(0, now.getTime() - updatedMs);

  return {
    projectId,
    present: true,
    held: true,
    holder: signal.holder,
    heldSinceIso: signal.updatedAt,
    heldForMs,
    isLongHeld: heldForMs > thresholds.longHoldAfterMs,
  };
}
