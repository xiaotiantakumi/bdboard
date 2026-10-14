/**
 * Single HTTP Range (RFC 9110 §14.2) for a resource of `size` bytes.
 * Invalid syntax and multiple ranges are ignored (`none`). A range that begins
 * at or past `size` is unsatisfiable (416). The inclusive end is clamped to the
 * resource and to `maxChunkBytes`.
 */

export type ByteRangeRequest =
  // Missing, blank, or invalid Range, including multiple ranges: treat as no Range.
  | { readonly kind: 'none' }
  /** Inclusive end, already clamped to `size - 1` and the chunk cap. */
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  /** 416 Range Not Satisfiable. */
  | { readonly kind: 'unsatisfiable' };

type DigitField =
  | { readonly kind: 'absent' }
  | { readonly kind: 'bad' }
  | { readonly kind: 'value'; readonly value: number };

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/i;

export function parseByteRange(
  header: string | undefined,
  size: number,
  maxChunkBytes: number,
): ByteRangeRequest {
  if (header === undefined) return { kind: 'none' };
  const trimmed = header.trim();
  if (trimmed.length === 0) return { kind: 'none' };

  const match = RANGE_PATTERN.exec(trimmed);
  if (match === null) return { kind: 'none' };

  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  // `bytes=-` matches the pattern but names no bound.
  if (startRaw.length === 0 && endRaw.length === 0) return { kind: 'none' };

  const start = readDigitField(startRaw);
  const end = readDigitField(endRaw);
  if (start.kind === 'bad' || end.kind === 'bad') return { kind: 'none' };

  if (start.kind === 'value' && end.kind === 'value') {
    if (end.value < start.value) return { kind: 'none' };
    if (start.value >= size) return { kind: 'unsatisfiable' };
    return {
      kind: 'range',
      start: start.value,
      end: clampInclusiveEnd(start.value, end.value, size, maxChunkBytes),
    };
  }

  if (start.kind === 'value' && end.kind === 'absent') {
    if (start.value >= size) return { kind: 'unsatisfiable' };
    return {
      kind: 'range',
      start: start.value,
      end: clampInclusiveEnd(start.value, size - 1, size, maxChunkBytes),
    };
  }

  if (start.kind === 'absent' && end.kind === 'value') {
    if (end.value === 0 || size === 0) return { kind: 'unsatisfiable' };
    const suffixStart = Math.max(0, size - end.value);
    return {
      kind: 'range',
      start: suffixStart,
      end: clampInclusiveEnd(suffixStart, size - 1, size, maxChunkBytes),
    };
  }

  return { kind: 'none' };
}

function readDigitField(raw: string): DigitField {
  if (raw.length === 0) return { kind: 'absent' };
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return { kind: 'bad' };
  return { kind: 'value', value };
}

/** 明示した終端も chunk 上限で切る。巨大な範囲指定でメモリに全部読まないため。 */
function clampInclusiveEnd(
  start: number,
  requestedEnd: number,
  size: number,
  maxChunkBytes: number,
): number {
  return Math.min(requestedEnd, size - 1, start + maxChunkBytes - 1);
}

export function formatContentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

export function formatUnsatisfiedContentRange(size: number): string {
  return `bytes */${size}`;
}
