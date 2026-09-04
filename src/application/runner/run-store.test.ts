import { describe, expect, it, vi } from 'vitest';
import type { RunOutcome } from '../ports/agent-runner.js';
import { createRunStore } from './run-store.js';

function makeStartEntry(id: string, ticketId = 'bdboard-1') {
  return {
    id,
    ticketId,
    runner: 'claude-spawn',
    mode: 'spawn' as const,
    cwd: '/tmp/wt',
  };
}

function makeOutcome(
  runId: string,
  ticketId: string,
  status: RunOutcome['run']['status'],
): RunOutcome {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');
  return {
    ok: status === 'succeeded',
    run: {
      id: runId,
      ticketId,
      runner: 'claude-spawn',
      mode: 'spawn',
      status,
      startedAt,
      finishedAt: new Date('2026-01-01T00:01:00.000Z'),
      exitCode: status === 'succeeded' ? 0 : 1,
    },
  };
}

describe('createRunStore', () => {
  it('blocks starting when the same ticket is already running', () => {
    const store = createRunStore();
    store.start(makeStartEntry('run-1', 'bdboard-1'));

    expect(store.canStart('bdboard-1')).toEqual({
      ok: false,
      reason: 'already-running',
    });
  });

  it('blocks starting when max concurrent runs is reached', () => {
    const store = createRunStore({ maxConcurrent: 2 });
    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.start(makeStartEntry('run-2', 'bdboard-2'));

    expect(store.canStart('bdboard-3')).toEqual({
      ok: false,
      reason: 'too-many-runs',
    });
  });

  it('keeps only the tail of log bytes in a ring buffer', () => {
    const store = createRunStore({ maxLogBytes: 20 });
    store.start(makeStartEntry('run-1'));

    store.appendChunk('run-1', { stream: 'stdout', text: '0123456789' });
    store.appendChunk('run-1', { stream: 'stdout', text: 'abcdefghij' });

    const record = store.get('run-1');
    expect(record?.log.length).toBeGreaterThan(0);
    expect(new TextEncoder().encode(record?.log ?? '').length).toBeLessThanOrEqual(20);
    expect(record?.log).toContain('abcdefghij');
  });

  it('drops oldest chunks when many appendChunk calls exceed maxLogBytes', () => {
    const store = createRunStore({ maxLogBytes: 64 });
    store.start(makeStartEntry('run-1'));

    for (let index = 0; index < 100; index += 1) {
      store.appendChunk('run-1', { stream: 'stdout', text: `chunk-${String(index).padStart(3, '0')}` });
    }

    const record = store.get('run-1');
    const logBytes = new TextEncoder().encode(record?.log ?? '').length;
    expect(logBytes).toBeLessThanOrEqual(64);
    expect(record?.log).toContain('chunk-099');
    expect(record?.log).not.toContain('chunk-000');
  });

  it('trims a single oversized chunk from the tail side', () => {
    const store = createRunStore({ maxLogBytes: 64 });
    store.start(makeStartEntry('run-1'));

    const oversized = 'x'.repeat(200);
    store.appendChunk('run-1', { stream: 'stdout', text: oversized });

    const record = store.get('run-1');
    const logBytes = new TextEncoder().encode(record?.log ?? '').length;
    expect(logBytes).toBeLessThanOrEqual(64);
    expect(record?.log.endsWith('x')).toBe(true);
  });

  it('does not leave broken utf-8 when trimming a single oversized multibyte chunk', () => {
    const store = createRunStore({ maxLogBytes: 64 });
    store.start(makeStartEntry('run-1'));

    store.appendChunk('run-1', { stream: 'stdout', text: 'あ'.repeat(200) });

    const record = store.get('run-1');
    const logBytes = new TextEncoder().encode(record?.log ?? '').length;
    expect(logBytes).toBeLessThanOrEqual(64);
    expect(record?.log).not.toContain('\uFFFD');
    expect([...(record?.log ?? '')].every((ch) => ch === 'あ')).toBe(true);
    expect(record?.log.endsWith('あ')).toBe(true);
    expect(record?.log.length).toBeLessThanOrEqual(21);
  });

  it('keeps the tail of multibyte log text in a ring buffer without replacement characters', () => {
    const store = createRunStore({ maxLogBytes: 64 });
    store.start(makeStartEntry('run-1'));

    for (let index = 0; index < 40; index += 1) {
      store.appendChunk('run-1', { stream: 'stdout', text: `日本語-${index}` });
    }

    const record = store.get('run-1');
    const logBytes = new TextEncoder().encode(record?.log ?? '').length;
    expect(logBytes).toBeLessThanOrEqual(64);
    expect(record?.log).not.toContain('\uFFFD');
    expect(record?.log).toContain('日本語-39');
    expect(record?.log.endsWith('日本語-39')).toBe(true);
  });

  it('keeps cancelled status when finish runs after cancel', () => {
    const store = createRunStore();
    store.start(makeStartEntry('run-1'));
    store.cancel('run-1');

    const record = store.finish(
      'run-1',
      makeOutcome('run-1', 'bdboard-1', 'failed'),
    );

    expect(record?.status).toBe('cancelled');
    expect(record?.exitCode).toBe(1);
  });

  it('blocks canStart immediately after cancel until finish', () => {
    const store = createRunStore({ maxConcurrent: 2 });
    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.cancel('run-1');

    expect(store.canStart('bdboard-1')).toEqual({
      ok: false,
      reason: 'already-running',
    });

    store.finish('run-1', makeOutcome('run-1', 'bdboard-1', 'failed'));
    expect(store.canStart('bdboard-1')).toEqual({ ok: true });
  });

  it('counts cancelling runs toward maxConcurrent', () => {
    const store = createRunStore({ maxConcurrent: 1 });
    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.cancel('run-1');

    expect(store.canStart('bdboard-2')).toEqual({
      ok: false,
      reason: 'too-many-runs',
    });
  });

  it('does not evict cancelling runs when retention limit is exceeded', () => {
    let tick = 0;
    const now = vi.fn(() => new Date(`2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z`));
    const store = createRunStore({ maxRetainedRuns: 1, now });

    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.cancel('run-1');

    store.start(makeStartEntry('run-2', 'bdboard-2'));
    store.finish('run-2', makeOutcome('run-2', 'bdboard-2', 'succeeded'));

    expect(store.get('run-1')?.status).toBe('cancelling');
  });

  it('evicts oldest finished runs when retention limit is exceeded', () => {
    let tick = 0;
    const now = vi.fn(() => new Date(`2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z`));
    const store = createRunStore({ maxRetainedRuns: 2, now });

    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.finish('run-1', makeOutcome('run-1', 'bdboard-1', 'succeeded'));

    store.start(makeStartEntry('run-2', 'bdboard-2'));
    store.finish('run-2', makeOutcome('run-2', 'bdboard-2', 'succeeded'));

    store.start(makeStartEntry('run-3', 'bdboard-3'));
    store.finish('run-3', makeOutcome('run-3', 'bdboard-3', 'succeeded'));

    expect(store.get('run-1')).toBeUndefined();
    expect(store.get('run-2')).toBeDefined();
    expect(store.get('run-3')).toBeDefined();
  });

  it('cancel marks the run cancelling and aborts the stored signal', () => {
    const store = createRunStore();
    store.start(makeStartEntry('run-1'));

    const signal = store.getAbortSignal('run-1');
    expect(signal).toBeDefined();

    const onAbort = vi.fn();
    signal?.addEventListener('abort', onAbort);

    const record = store.cancel('run-1');

    expect(onAbort).toHaveBeenCalled();
    expect(record?.status).toBe('cancelling');
    expect(record?.finishedAt).toBeUndefined();
  });

  it('cancelAll cancels every running and cancelling run', () => {
    const store = createRunStore({ maxConcurrent: 3 });
    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.start(makeStartEntry('run-2', 'bdboard-2'));
    store.cancel('run-2');
    store.start(makeStartEntry('run-3', 'bdboard-3'));
    store.finish('run-3', makeOutcome('run-3', 'bdboard-3', 'succeeded'));

    const cancelled = store.cancelAll();

    expect(cancelled.map((record) => record.id).sort()).toEqual(['run-1', 'run-2']);
    expect(store.get('run-1')?.status).toBe('cancelling');
    expect(store.get('run-2')?.status).toBe('cancelling');
    expect(store.get('run-3')?.status).toBe('succeeded');
  });

  it('lists runs with optional filters', () => {
    const store = createRunStore();
    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.start(makeStartEntry('run-2', 'bdboard-2'));
    store.cancel('run-2');

    expect(store.list({ ticketId: 'bdboard-1' })).toHaveLength(1);
    expect(store.list({ status: 'cancelling' })).toHaveLength(1);
  });

  it('keeps cancelling status and blocks slots before the cancel grace elapses', () => {
    let currentMs = 0;
    const now = vi.fn(() => new Date(currentMs));
    const store = createRunStore({
      maxConcurrent: 1,
      cancellingGraceMs: 5_000,
      now,
    });

    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.cancel('run-1');

    currentMs = 4_999;
    expect(store.get('run-1')?.status).toBe('cancelling');
    expect(store.canStart('bdboard-1')).toEqual({
      ok: false,
      reason: 'already-running',
    });
    expect(store.canStart('bdboard-2')).toEqual({
      ok: false,
      reason: 'too-many-runs',
    });
  });

  it('force-cancels stuck cancelling runs after the grace period and frees slots', () => {
    let currentMs = 0;
    const now = vi.fn(() => new Date(currentMs));
    const store = createRunStore({
      maxConcurrent: 1,
      cancellingGraceMs: 5_000,
      now,
    });

    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.cancel('run-1');

    currentMs = 5_000;
    const record = store.get('run-1');

    expect(record?.status).toBe('cancelled');
    expect(record?.finishedAt).toEqual(new Date(5_000));
    expect(record?.error).toBe(
      'cancelled: process did not exit within the cancel grace period',
    );
    expect(store.canStart('bdboard-1')).toEqual({ ok: true });
    expect(store.canStart('bdboard-2')).toEqual({ ok: true });
  });

  it('cancelAllAndWait resolves when finish completes an active run', async () => {
    const store = createRunStore();
    store.start(makeStartEntry('run-1', 'bdboard-1'));

    const waitPromise = store.cancelAllAndWait(1_000);
    store.finish('run-1', makeOutcome('run-1', 'bdboard-1', 'failed'));

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('cancelAllAndWait resolves after timeoutMs when finish never arrives', async () => {
    const store = createRunStore();
    store.start(makeStartEntry('run-1', 'bdboard-1'));

    const started = Date.now();
    await store.cancelAllAndWait(10);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(store.get('run-1')?.status).toBe('cancelling');
  });

  it('cancelAllAndWait resolves immediately when no active runs exist', async () => {
    const store = createRunStore();
    store.start(makeStartEntry('run-1', 'bdboard-1'));
    store.finish('run-1', makeOutcome('run-1', 'bdboard-1', 'succeeded'));

    const started = Date.now();
    await store.cancelAllAndWait(1_000);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(50);
  });
});
