import { describe, expect, it } from 'vitest';
import {
  BD_TICKET_ID_PATTERN,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_SESSION_ID_MAX_LENGTH,
  isSafeCliArgument,
  isValidBdTicketId,
  isValidChatSessionId,
} from './chat.js';

describe('CHAT_MESSAGE_MAX_LENGTH', () => {
  it('is 4000', () => {
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(4000);
  });
});

describe('isSafeCliArgument', () => {
  it('accepts safe values', () => {
    expect(isSafeCliArgument('bdboard-3tw.13')).toBe(true);
    expect(isSafeCliArgument('open')).toBe(true);
    expect(isSafeCliArgument('a b')).toBe(true);
    expect(isSafeCliArgument('../x')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isSafeCliArgument('')).toBe(false);
  });

  it('rejects values starting with -', () => {
    expect(isSafeCliArgument('-rf')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isSafeCliArgument('a\u0000b')).toBe(false);
    expect(isSafeCliArgument('a\u001fb')).toBe(false);
    expect(isSafeCliArgument('a\u007fb')).toBe(false);
  });

  it('rejects newline characters', () => {
    expect(isSafeCliArgument('a\nb')).toBe(false);
    expect(isSafeCliArgument('a\rb')).toBe(false);
  });
});

describe('isValidBdTicketId', () => {
  it('accepts valid ticket ids', () => {
    expect(isValidBdTicketId('bdboard-3tw.13')).toBe(true);
    expect(isValidBdTicketId('ExampleApp-w5a')).toBe(true);
    expect(BD_TICKET_ID_PATTERN.test('bdboard-3tw.13')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidBdTicketId('')).toBe(false);
  });

  it('rejects values starting with -', () => {
    expect(isValidBdTicketId('-rf')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isValidBdTicketId('a\u0000b')).toBe(false);
  });

  it('rejects values over 200 characters', () => {
    const longId = `a${'b'.repeat(200)}`;
    expect(longId.length).toBeGreaterThan(200);
    expect(isValidBdTicketId(longId)).toBe(false);
  });

  it('rejects ids that fail the pattern', () => {
    expect(isValidBdTicketId('../x')).toBe(false);
    expect(isValidBdTicketId('a b')).toBe(false);
  });
});

describe('isValidChatSessionId', () => {
  it('accepts a UUID', () => {
    expect(isValidChatSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(
      true,
    );
  });

  it('accepts non-UUID printable strings', () => {
    expect(isValidChatSessionId('sess_ABC-123.xyz')).toBe(true);
    expect(isValidChatSessionId('01K9ZQ8H')).toBe(true);
  });

  it('accepts exactly 200 characters and rejects 201', () => {
    const exactly200 = 'a'.repeat(200);
    expect(exactly200.length).toBe(CHAT_SESSION_ID_MAX_LENGTH);
    expect(isValidChatSessionId(exactly200)).toBe(true);

    const over200 = 'a'.repeat(201);
    expect(over200.length).toBe(CHAT_SESSION_ID_MAX_LENGTH + 1);
    expect(isValidChatSessionId(over200)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidChatSessionId('')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isValidChatSessionId('a\u0000b')).toBe(false);
    expect(isValidChatSessionId('a\u001fb')).toBe(false);
    expect(isValidChatSessionId('a\u007fb')).toBe(false);
  });

  it('rejects newline characters', () => {
    expect(isValidChatSessionId('a\nb')).toBe(false);
    expect(isValidChatSessionId('a\rb')).toBe(false);
  });

  it('rejects values starting with -', () => {
    expect(isValidChatSessionId('-rf')).toBe(false);
  });
});
