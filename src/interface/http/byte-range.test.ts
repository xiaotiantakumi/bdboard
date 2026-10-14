import { describe, expect, it } from 'vitest';
import {
  formatContentRange,
  formatUnsatisfiedContentRange,
  parseByteRange,
} from './byte-range.js';

const MIB = 1024 * 1024;
const CHUNK = 4 * MIB;

describe('parseByteRange', () => {
  it('caps an open-ended range at one chunk', () => {
    expect(parseByteRange('bytes=0-', 10 * MIB, CHUNK)).toEqual({
      kind: 'range',
      start: 0,
      end: CHUNK - 1,
    });
  });

  it('returns an inclusive 10-byte range', () => {
    expect(parseByteRange('bytes=10-19', 100, CHUNK)).toEqual({
      kind: 'range',
      start: 10,
      end: 19,
    });
  });

  it('clamps the end to the last byte of a short resource', () => {
    expect(parseByteRange('bytes=0-999999', 100, CHUNK)).toEqual({
      kind: 'range',
      start: 0,
      end: 99,
    });
    expect(parseByteRange('bytes=0-', 100, CHUNK)).toEqual({
      kind: 'range',
      start: 0,
      end: 99,
    });
  });

  it('caps an explicit end at the chunk size', () => {
    expect(parseByteRange('bytes=0-99999999', 100 * MIB, CHUNK)).toEqual({
      kind: 'range',
      start: 0,
      end: CHUNK - 1,
    });
  });

  it('resolves a suffix range from the end of the resource', () => {
    expect(parseByteRange('bytes=-5', 100, CHUNK)).toEqual({
      kind: 'range',
      start: 95,
      end: 99,
    });
    expect(parseByteRange('bytes=-500', 100, CHUNK)).toEqual({
      kind: 'range',
      start: 0,
      end: 99,
    });
  });

  it('marks a range past the end, an empty resource, and a zero suffix unsatisfiable', () => {
    expect(parseByteRange('bytes=100-', 50, CHUNK)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=50-60', 50, CHUNK)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=0-', 0, CHUNK)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-0', 100, CHUNK)).toEqual({ kind: 'unsatisfiable' });
  });

  it('marks a bound that is not a safe integer unsatisfiable', () => {
    expect(parseByteRange('bytes=99999999999999999999-', 100, CHUNK)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=0-99999999999999999999', 100, CHUNK)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-99999999999999999999', 100, CHUNK)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores a missing, blank, or invalid Range header', () => {
    expect(parseByteRange(undefined, 100, CHUNK)).toEqual({ kind: 'none' });
    expect(parseByteRange('', 100, CHUNK)).toEqual({ kind: 'none' });
    expect(parseByteRange('   ', 100, CHUNK)).toEqual({ kind: 'none' });
    expect(parseByteRange('bytes=0-1,5-6', 100, CHUNK)).toEqual({ kind: 'none' });
    expect(parseByteRange('bytes=5-3', 100, CHUNK)).toEqual({ kind: 'none' });
    expect(parseByteRange('bytes=-', 100, CHUNK)).toEqual({ kind: 'none' });
    expect(parseByteRange('items=0-1', 100, CHUNK)).toEqual({ kind: 'none' });
    expect(parseByteRange('bytes=a-b', 100, CHUNK)).toEqual({ kind: 'none' });
  });

  it('accepts an uppercase unit and surrounding whitespace', () => {
    expect(parseByteRange('BYTES=0-1', 100, CHUNK)).toEqual({
      kind: 'range',
      start: 0,
      end: 1,
    });
    expect(parseByteRange(' bytes=0-1 ', 100, CHUNK)).toEqual({
      kind: 'range',
      start: 0,
      end: 1,
    });
  });
});

describe('Content-Range formatting', () => {
  it('formats a satisfied range and an unsatisfied range', () => {
    expect(formatContentRange(10, 19, 100)).toEqual('bytes 10-19/100');
    expect(formatUnsatisfiedContentRange(50)).toEqual('bytes */50');
  });
});
