import { afterEach, describe, expect, it } from 'vitest';
import {
  getBoardTimeZone,
  resetBoardTimeZoneForTests,
  setBoardTimeZoneOverride,
} from './boardTimeZone';

describe('boardTimeZone', () => {
  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('uses browser timezone by default', () => {
    expect(getBoardTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('uses server override when set', () => {
    setBoardTimeZoneOverride('Asia/Tokyo');
    expect(getBoardTimeZone()).toBe('Asia/Tokyo');
  });
});
