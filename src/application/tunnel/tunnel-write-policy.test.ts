import { describe, expect, it } from 'vitest';
import {
  MIN_TUNNEL_WRITE_PASSWORD_LENGTH,
  passwordAllowsTunnelWrites,
  passwordCodePointLength,
} from './tunnel-write-policy.js';

describe('passwordAllowsTunnelWrites', () => {
  it('always allows writes for an auto-generated passphrase', () => {
    expect(passwordAllowsTunnelWrites('generated', 'ab')).toBe(true);
    expect(passwordAllowsTunnelWrites('generated', '')).toBe(true);
  });

  // 境界値。11 文字は不可 / 12 文字は可。ここが 1 文字ずれると、
  // 「短いパスワードのトンネルが書き込み可能なまま公開される」に直結する。
  it('rejects a user-supplied password one character below the threshold', () => {
    const password = 'a'.repeat(MIN_TUNNEL_WRITE_PASSWORD_LENGTH - 1);
    expect(password).toHaveLength(11);
    expect(passwordAllowsTunnelWrites('user-supplied', password)).toBe(false);
  });

  it('allows a user-supplied password exactly at the threshold', () => {
    const password = 'a'.repeat(MIN_TUNNEL_WRITE_PASSWORD_LENGTH);
    expect(password).toHaveLength(12);
    expect(passwordAllowsTunnelWrites('user-supplied', password)).toBe(true);
  });

  it('rejects the shortest password the tunnel API still accepts', () => {
    // /api/tunnel/start は 2 文字から通す(5149cd4)。起動は通るが書き込みは開かない。
    expect(passwordAllowsTunnelWrites('user-supplied', 'ab')).toBe(false);
  });

  it('counts code points rather than UTF-16 units', () => {
    // 絵文字はサロゲートペアなので UTF-16 長では 12、コードポイントでは 6。
    const sixEmoji = '😀'.repeat(6);
    expect(sixEmoji.length).toBe(12);
    expect(passwordCodePointLength(sixEmoji)).toBe(6);
    expect(passwordAllowsTunnelWrites('user-supplied', sixEmoji)).toBe(false);

    const twelveEmoji = '😀'.repeat(12);
    expect(passwordAllowsTunnelWrites('user-supplied', twelveEmoji)).toBe(true);
  });
});
