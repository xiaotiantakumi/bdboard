import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../domain/session.js';
import { createSessionLivenessTracker } from './session-liveness-tracker.js';

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 's1',
    pid: 1,
    cwd: '/repo',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: new Date('2026-01-01T00:00:00Z'),
    alive: true,
    ...overrides,
  };
}

describe('createSessionLivenessTracker (bdboard-sso1.9 move only)', () => {
  it('current() starts empty and refresh() populates it from the registry', async () => {
    const registry = { listSessions: vi.fn(async () => [session()]) };
    const tracker = createSessionLivenessTracker({
      registry,
      now: () => new Date('2026-01-01T00:00:00Z'),
      publishSessionDied: vi.fn(),
      publishSessionsChanged: vi.fn(),
    });

    expect(tracker.current()).toEqual([]);
    await tracker.refresh();
    expect(tracker.current()).toEqual([session()]);
  });

  it('publishes session.changed only on the second refresh once the fingerprint actually differs', async () => {
    let sessions: readonly AgentSession[] = [session()];
    const registry = { listSessions: vi.fn(async () => sessions) };
    const publishSessionsChanged = vi.fn();
    const tracker = createSessionLivenessTracker({
      registry,
      now: () => new Date('2026-01-01T00:00:00Z'),
      publishSessionDied: vi.fn(),
      publishSessionsChanged,
    });

    await tracker.refresh(); // first call only seeds previousFingerprint, never "changed"
    expect(publishSessionsChanged).not.toHaveBeenCalled();

    await tracker.refresh(); // identical snapshot -> fingerprint unchanged
    expect(publishSessionsChanged).not.toHaveBeenCalled();

    sessions = [session({ alive: false })];
    await tracker.refresh();
    expect(publishSessionsChanged).toHaveBeenCalledWith({ count: 1, activeCount: 0 });
  });

  it('publishes a died notification per session that transitions alive -> dead', async () => {
    let sessions: readonly AgentSession[] = [session({ alive: true })];
    const registry = { listSessions: vi.fn(async () => sessions) };
    const publishSessionDied = vi.fn();
    const tracker = createSessionLivenessTracker({
      registry,
      now: () => new Date('2026-01-02T00:00:00Z'),
      publishSessionDied,
      publishSessionsChanged: vi.fn(),
    });

    await tracker.refresh();
    expect(publishSessionDied).not.toHaveBeenCalled();

    sessions = [session({ alive: false })];
    await tracker.refresh();

    expect(publishSessionDied).toHaveBeenCalledTimes(1);
    expect(publishSessionDied).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session_died', sessionId: 's1' }),
    );
  });

  it('swallows registry errors, logs via onError, and leaves current() unchanged', async () => {
    const registry = { listSessions: vi.fn(async () => [session()]) };
    const onError = vi.fn();
    const tracker = createSessionLivenessTracker({
      registry,
      now: () => new Date('2026-01-01T00:00:00Z'),
      publishSessionDied: vi.fn(),
      publishSessionsChanged: vi.fn(),
      onError,
    });
    await tracker.refresh();
    expect(tracker.current()).toEqual([session()]);

    registry.listSessions.mockRejectedValueOnce(new Error('boom'));
    await expect(tracker.refresh()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(tracker.current()).toEqual([session()]);
  });
});
