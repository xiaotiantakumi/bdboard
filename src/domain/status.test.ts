import { describe, expect, it } from 'vitest';
import {
  comparePriority,
  isPriority,
  isStatus,
  PRIORITIES,
  TICKET_STATUSES,
} from './status.js';

describe('isStatus', () => {
  it('accepts known ticket statuses', () => {
    for (const status of TICKET_STATUSES) {
      expect(isStatus(status)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isStatus('done')).toBe(false);
    expect(isStatus(null)).toBe(false);
    expect(isStatus(1)).toBe(false);
  });
});

describe('isPriority', () => {
  it('accepts known priorities', () => {
    for (const priority of PRIORITIES) {
      expect(isPriority(priority)).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(isPriority(5)).toBe(false);
    expect(isPriority(-1)).toBe(false);
    expect(isPriority('1')).toBe(false);
    expect(isPriority(null)).toBe(false);
  });
});

describe('comparePriority', () => {
  it('orders lower numeric values first (higher priority)', () => {
    expect(comparePriority(0, 1)).toBeLessThan(0);
    expect(comparePriority(1, 0)).toBeGreaterThan(0);
    expect(comparePriority(2, 2)).toBe(0);
  });
});
