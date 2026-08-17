import { compareStrings } from '../../domain/compare.js';

export interface ScanTarget {
  readonly filePath: string;
  readonly sessionId: string;
  readonly size: number;
  readonly previousOffset: number | undefined;
}

export interface ScanSlice {
  readonly filePath: string;
  readonly sessionId: string;
  readonly start: number;
  readonly length: number;
  readonly newOffset: number;
}

export const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
export const TICK_BUDGET_BYTES = 8 * 1024 * 1024;

function compareTargets(a: ScanTarget, b: ScanTarget): number {
  const aTracked = a.previousOffset !== undefined;
  const bTracked = b.previousOffset !== undefined;
  if (aTracked !== bTracked) {
    return aTracked ? -1 : 1;
  }
  return compareStrings(a.filePath, b.filePath);
}

function computeSliceBounds(
  target: ScanTarget,
  initialTailBytes: number,
): { readonly start: number; readonly length: number } | undefined {
  const { size, previousOffset } = target;
  if (size === 0) {
    return undefined;
  }

  if (previousOffset !== undefined && previousOffset === size) {
    return undefined;
  }

  let start: number;
  if (previousOffset === undefined || previousOffset > size) {
    start = Math.max(0, size - initialTailBytes);
  } else {
    start = previousOffset;
  }

  const length = size - start;
  if (length <= 0) {
    return undefined;
  }

  return { start, length };
}

export function planScan(
  targets: readonly ScanTarget[],
  options?: { readonly initialTailBytes?: number; readonly budgetBytes?: number },
): readonly ScanSlice[] {
  const initialTailBytes = options?.initialTailBytes ?? INITIAL_TAIL_BYTES;
  const budgetBytes = options?.budgetBytes ?? TICK_BUDGET_BYTES;
  const sortedTargets = [...targets].sort(compareTargets);
  const slices: ScanSlice[] = [];
  let remainingBudget = budgetBytes;

  for (const target of sortedTargets) {
    if (remainingBudget <= 0) {
      break;
    }

    const bounds = computeSliceBounds(target, initialTailBytes);
    if (bounds === undefined) {
      continue;
    }

    const length = Math.min(bounds.length, remainingBudget);
    if (length <= 0) {
      continue;
    }

    const start = bounds.start;
    const newOffset = start + length;
    slices.push({
      filePath: target.filePath,
      sessionId: target.sessionId,
      start,
      length,
      newOffset,
    });
    remainingBudget -= length;

    if (length < bounds.length) {
      break;
    }
  }

  return slices;
}
