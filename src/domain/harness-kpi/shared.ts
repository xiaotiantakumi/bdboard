import type { HarnessKpiRange } from './types.js';

export function isInRange(at: Date, range: HarnessKpiRange): boolean {
  const timestamp = at.getTime();
  return timestamp >= range.start.getTime() && timestamp <= range.end.getTime();
}
