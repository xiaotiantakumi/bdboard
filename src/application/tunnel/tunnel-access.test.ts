import { describe, expect, it } from 'vitest';
import { createTunnelAccessService } from './tunnel-access.js';

describe('createTunnelAccessService', () => {
  it('issues a token that can be consumed exactly once', () => {
    let currentTime = new Date('2026-08-15T00:00:00.000Z');
    const access = createTunnelAccessService({ now: () => currentTime });

    access.beginTunnelSession();
    const issued = access.issueToken();
    expect(issued).not.toBeNull();

    const first = access.consumeToken(issued!.token);
    expect(first).not.toBeNull();
    expect(first!.sessionId.length).toBeGreaterThan(20);

    const second = access.consumeToken(issued!.token);
    expect(second).toBeNull();
  });

  it('rejects expired tokens', () => {
    let currentTime = new Date('2026-08-15T00:00:00.000Z');
    const access = createTunnelAccessService({
      now: () => currentTime,
      tokenTtlMs: 60_000,
    });

    access.beginTunnelSession();
    const issued = access.issueToken();
    expect(issued).not.toBeNull();

    currentTime = new Date('2026-08-15T00:01:01.000Z');
    expect(access.consumeToken(issued!.token)).toBeNull();
  });

  it('invalidates tokens and sessions after endTunnelSession', () => {
    const access = createTunnelAccessService({ now: () => new Date() });

    access.beginTunnelSession();
    const issued = access.issueToken();
    const consumed = access.consumeToken(issued!.token);
    expect(consumed).not.toBeNull();

    access.endTunnelSession();

    expect(access.consumeToken(issued!.token)).toBeNull();
    expect(access.isValidSession(consumed!.sessionId)).toBe(false);
    expect(access.issueToken()).toBeNull();
  });

  it('invalidates previous session after beginTunnelSession is called again', () => {
    const access = createTunnelAccessService({ now: () => new Date() });

    access.beginTunnelSession();
    const issued = access.issueToken();
    const consumed = access.consumeToken(issued!.token);
    expect(consumed).not.toBeNull();
    expect(access.isValidSession(consumed!.sessionId)).toBe(true);

    access.beginTunnelSession();
    expect(access.isValidSession(consumed!.sessionId)).toBe(false);
    expect(access.consumeToken(issued!.token)).toBeNull();
  });

  it('generates sufficiently long and distinct tokens', () => {
    const access = createTunnelAccessService({ now: () => new Date() });
    access.beginTunnelSession();

    const first = access.issueToken();
    const second = access.issueToken();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.token.length).toBeGreaterThanOrEqual(32);
    expect(second!.token.length).toBeGreaterThanOrEqual(32);
    expect(first!.token).not.toBe(second!.token);
  });

  it('returns null from issueToken when no tunnel session is active', () => {
    const access = createTunnelAccessService({ now: () => new Date() });
    expect(access.issueToken()).toBeNull();
  });
});
