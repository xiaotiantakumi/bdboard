import { describe, expect, it } from 'vitest';
import {
  InvalidTicketIdError,
  isTicketId,
  parentTicketId,
  parseTicketId,
  rootTicketId,
  ticketIdDepth,
} from './ticket-id.js';

describe('parseTicketId', () => {
  it('splits prefix and shortId from a bead ticket id', () => {
    expect(parseTicketId('ExampleApp-w5a')).toEqual({
      prefix: 'ExampleApp',
      shortId: 'w5a',
    });
  });

  it('splits at the last dash when prefix contains dashes', () => {
    expect(parseTicketId('sample-project-86o')).toEqual({
      prefix: 'sample-project',
      shortId: '86o',
    });
    expect(parseTicketId('epic-haslett-00ae14')).toEqual({
      prefix: 'epic-haslett',
      shortId: '00ae14',
    });
  });

  it('preserves hierarchical shortId suffixes', () => {
    expect(parseTicketId('bdboard-3tw.10')).toEqual({
      prefix: 'bdboard',
      shortId: '3tw.10',
    });
    expect(parseTicketId('ExampleApp-ase.2')).toEqual({
      prefix: 'ExampleApp',
      shortId: 'ase.2',
    });
  });

  it('throws InvalidTicketIdError for invalid ids', () => {
    const cases: Array<{ id: string; reason: string }> = [
      { id: '', reason: 'empty' },
      { id: 'nodash', reason: 'no dash' },
      { id: '-short', reason: 'empty prefix' },
      { id: 'prefix-', reason: 'empty shortId' },
      { id: 'a-3tw.', reason: 'empty segment' },
      { id: 'a-3tw..2', reason: 'empty segment' },
      { id: ' a-b', reason: 'whitespace' },
      { id: 'a- b', reason: 'whitespace' },
      { id: 'a-b ', reason: 'whitespace' },
    ];

    for (const { id } of cases) {
      expect(() => parseTicketId(id)).toThrow(InvalidTicketIdError);
    }
  });

  it('sets error name and includes id and reason in message', () => {
    try {
      parseTicketId('invalid');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTicketIdError);
      expect((error as InvalidTicketIdError).name).toBe('InvalidTicketIdError');
      expect((error as InvalidTicketIdError).message).toContain('invalid');
    }
  });
});

describe('isTicketId', () => {
  it('returns true for valid ids', () => {
    expect(isTicketId('ExampleApp-w5a')).toBe(true);
    expect(isTicketId('bdboard-3tw.10')).toBe(true);
  });

  it('returns false for invalid ids without throwing', () => {
    expect(isTicketId('')).toBe(false);
    expect(isTicketId('nodash')).toBe(false);
    expect(isTicketId('a-3tw.')).toBe(false);
  });
});

describe('parentTicketId', () => {
  it('removes the last hierarchical segment from shortId', () => {
    expect(parentTicketId('bdboard-3tw.10')).toBe('bdboard-3tw');
    expect(parentTicketId('a-b.1.2')).toBe('a-b.1');
  });

  it('returns null when there is no hierarchical suffix', () => {
    expect(parentTicketId('bdboard-3tw')).toBeNull();
    expect(parentTicketId('ExampleApp-w5a')).toBeNull();
  });

  it('throws for invalid ids', () => {
    expect(() => parentTicketId('invalid')).toThrow(InvalidTicketIdError);
  });
});

describe('rootTicketId', () => {
  it('strips all hierarchical suffixes', () => {
    expect(rootTicketId('a-b.1.2')).toBe('a-b');
    expect(rootTicketId('bdboard-3tw.10')).toBe('bdboard-3tw');
    expect(rootTicketId('bdboard-3tw')).toBe('bdboard-3tw');
  });

  it('throws for invalid ids', () => {
    expect(() => rootTicketId('invalid')).toThrow(InvalidTicketIdError);
  });
});

describe('ticketIdDepth', () => {
  it('counts hierarchical depth from shortId suffix', () => {
    expect(ticketIdDepth('a-b')).toBe(0);
    expect(ticketIdDepth('a-b.1')).toBe(1);
    expect(ticketIdDepth('a-b.1.2')).toBe(2);
  });

  it('throws for invalid ids', () => {
    expect(() => ticketIdDepth('invalid')).toThrow(InvalidTicketIdError);
  });
});
