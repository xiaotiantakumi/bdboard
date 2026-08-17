import { describe, expect, it, vi } from 'vitest';
import { createChatSessionStore } from './chat-session-store.js';

describe('createChatSessionStore', () => {
  it('remembers and recognizes session ids per project', () => {
    const store = createChatSessionStore();

    store.remember('project-a', 'session-1', 'claude');

    expect(store.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });
    expect(store.lookup('project-a', 'session-2')).toBeUndefined();
  });

  it('does not leak session ids across projects', () => {
    const store = createChatSessionStore();

    store.remember('project-a', 'session-1', 'claude');

    expect(store.lookup('project-b', 'session-1')).toBeUndefined();
  });

  it('lists and forgets sessions through the repository facade', () => {
    const store = createChatSessionStore();
    store.remember('project-a', 'session-a', 'claude');
    store.remember('project-b', 'session-b', 'codex');

    expect(store.listByProject('project-a').map((row) => row.sessionId)).toEqual(['session-a']);
    store.forget('project-a', 'session-a');
    expect(store.lookup('project-a', 'session-a')).toBeUndefined();
    expect(store.lookup('project-b', 'session-b')).toEqual({ agentId: 'codex' });
  });

  it('rejects a second acquire while the project is locked', () => {
    const store = createChatSessionStore();

    expect(store.tryAcquire('project-a')).toBe(true);
    expect(store.tryAcquire('project-a')).toBe(false);
  });

  it('allows acquire again after release', () => {
    const store = createChatSessionStore();

    expect(store.tryAcquire('project-a')).toBe(true);
    store.release('project-a');
    expect(store.tryAcquire('project-a')).toBe(true);
  });

  it('drops the oldest remembered sessions when the per-project cap is exceeded', () => {
    const store = createChatSessionStore({ maxSessionsPerProject: 3 });

    store.remember('project-a', 'session-1', 'claude');
    store.remember('project-a', 'session-2', 'claude');
    store.remember('project-a', 'session-3', 'claude');
    store.remember('project-a', 'session-4', 'claude');

    expect(store.lookup('project-a', 'session-1')).toBeUndefined();
    expect(store.lookup('project-a', 'session-2')).toEqual({
      agentId: 'claude',
    });
    expect(store.lookup('project-a', 'session-3')).toEqual({
      agentId: 'claude',
    });
    expect(store.lookup('project-a', 'session-4')).toEqual({
      agentId: 'claude',
    });
  });

  it('does not duplicate remembered session ids', () => {
    const store = createChatSessionStore({ maxSessionsPerProject: 2 });

    store.remember('project-a', 'session-1', 'claude');
    store.remember('project-a', 'session-2', 'claude');
    store.remember('project-a', 'session-1', 'codex');

    expect(store.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });
    expect(store.lookup('project-a', 'session-2')).toEqual({
      agentId: 'claude',
    });
  });

  it('does not overwrite agentId when re-remembering the same session id', () => {
    const store = createChatSessionStore();

    store.remember('project-a', 'session-1', 'claude');
    store.remember('project-a', 'session-1', 'codex');

    expect(store.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
    });
  });

  it('updates the model without changing the agentId', () => {
    const store = createChatSessionStore();
    store.remember('project-a', 'session-1', 'claude');

    store.updateModel('project-a', 'session-1', 'opus');

    expect(store.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
      model: 'opus',
    });
  });

  it('does nothing when updating an unknown session model', () => {
    const store = createChatSessionStore();

    store.updateModel('project-a', 'unknown-session', 'opus');

    expect(store.lookup('project-a', 'unknown-session')).toBeUndefined();
  });

  it('renames and pins sessions through the in-memory repository', () => {
    const store = createChatSessionStore();
    store.remember('project-a', 'session-1', 'claude');

    store.rename('project-a', 'session-1', '運用相談');
    store.setPinned('project-a', 'session-1', true);

    expect(store.lookup('project-a', 'session-1')).toEqual({
      agentId: 'claude',
      title: '運用相談',
      pinned: true,
    });
    expect(store.listByProject('project-a')).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        title: '運用相談',
        pinned: true,
      }),
    ]);
  });

  it('clears a custom title when rename is called with null', () => {
    const store = createChatSessionStore();
    store.remember('project-a', 'session-1', 'claude');
    store.rename('project-a', 'session-1', '運用相談');

    store.rename('project-a', 'session-1', null);

    expect(store.lookup('project-a', 'session-1')).toEqual({ agentId: 'claude' });
    expect(store.listByProject('project-a')[0]?.title).toBeNull();
  });

  it('no-ops rename and setPinned for unknown sessions', () => {
    const store = createChatSessionStore();

    store.rename('project-a', 'missing', 'ignored');
    store.setPinned('project-a', 'missing', true);

    expect(store.lookup('project-a', 'missing')).toBeUndefined();
  });

  it('delegates rename and setPinned to the injected repository', () => {
    const rename = vi.fn();
    const setPinned = vi.fn();
    const store = createChatSessionStore({
      repository: {
        remember: () => {},
        updateModel: () => {},
        rename,
        setPinned,
        lookup: () => ({ agentId: 'claude' }),
        listByProject: () => [],
        forget: () => {},
      },
    });

    store.rename('project-a', 'session-1', '運用相談');
    store.setPinned('project-a', 'session-1', true);

    expect(rename).toHaveBeenCalledWith('project-a', 'session-1', '運用相談');
    expect(setPinned).toHaveBeenCalledWith('project-a', 'session-1', true);
  });

  it('does not carry an acquired lock over to a new store instance ("restart")', () => {
    // locks はプロセス内限定の概念であり、repository (永続化先) を共有していても
    // ストアのインスタンスが変われば (＝プロセス再起動を模す) ロック残留は無いはず。
    const before = createChatSessionStore();
    expect(before.tryAcquire('project-a')).toBe(true);
    // 意図的に release しない: 再起動でロックが解放されずに終わったケースを模す。

    const after = createChatSessionStore();
    expect(after.tryAcquire('project-a')).toBe(true);
  });
});
