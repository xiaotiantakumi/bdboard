export interface ParsedReclaimOutput {
  /** パース不能なら null */
  readonly count: number | null;
  readonly summary: string;
}

const RECLAIM_COUNT_PATTERNS: readonly RegExp[] = [
  /reclaimed\s+(\d+)\s+issue/i,
  /(\d+)\s+issue(?:s)?\s+reclaimed/i,
  /reclaimed\s+(\d+)/i,
];

/**
 * bd reclaim の stdout から回収件数を推定する。
 * 形式が変わった場合は count=null として summary のみ返す。
 */
export function parseReclaimStdout(stdout: string): ParsedReclaimOutput {
  const summary = stdout.trim();
  if (summary.length === 0) {
    return { count: 0, summary };
  }

  for (const pattern of RECLAIM_COUNT_PATTERNS) {
    const match = summary.match(pattern);
    if (match !== null) {
      const parsed = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(parsed)) {
        return { count: parsed, summary };
      }
    }
  }

  return { count: null, summary };
}
