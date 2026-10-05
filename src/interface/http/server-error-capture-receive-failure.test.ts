/**
 * bdboard-4y8q.6.10: X-Bdboard-Error-Draft の意味を、本物の reporter (間引き付き) と、保存に失敗する・保存の終わらない receive で固定する。
 * `throttled` は「同じ失敗を保存できている」ことだけを言う。保存に失敗した失敗は `skipped` で、次の同じ失敗がもう一度保存を試みる。
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSelfErrorReporter } from '../../application/issue-report/self-error-reporter.js';
import type { SelfErrorReporterDeps } from '../../application/issue-report/self-error-reporter.js';
import { createSelfErrorThrottle } from '../../domain/self-error-throttle.js';
import { ERROR_DRAFT_HEADER, createServerErrorCapture, serverErrorHandler } from './server-error-capture.js';

const unsaved = { ok: false, reason: 'storage-full' } as const;

function build(receive: SelfErrorReporterDeps['service']['receive']) {
  const reporter = createSelfErrorReporter({
    service: { receive },
    throttle: createSelfErrorThrottle(),
    listProjects: () => [],
    envInfo: () => ({}),
    log: () => undefined,
    now: () => new Date(0),
  });
  const app = new Hono();
  app.onError(serverErrorHandler);
  app.use('*', createServerErrorCapture({ reporter }));
  app.get('/api/boom', () => {
    throw new Error('cannot read board');
  });
  return { app, report: vi.spyOn(reporter, 'report') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('X-Bdboard-Error-Draft with a real reporter', () => {
  it('says skipped when the draft could not be saved, and the next identical failure tries to save again (recorded, then throttled)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const receive = vi.fn().mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { app } = build(receive);
    const headers: Array<string | null> = [];
    for (let round = 0; round < 3; round += 1) headers.push((await app.request('/api/boom')).headers.get(ERROR_DRAFT_HEADER));
    expect(headers).toEqual(['skipped', 'recorded', 'throttled']);
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('keeps one draft for two identical failures that overlap: the second waits for the first save and answers throttled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release!: (value: unknown) => void;
    const receive = vi.fn().mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValue({ ok: true });
    const { app, report } = build(receive);
    const first = app.request('/api/boom');
    const second = app.request('/api/boom');
    // 2 本とも reporter まで届いてから、1 本目の保存を終える (1 回目の保存が終わらないうちに 2 回目が来る)。
    await vi.waitFor(() => { expect(report).toHaveBeenCalledTimes(2); });
    expect(receive).toHaveBeenCalledTimes(1);
    release({ ok: true });
    expect((await first).headers.get(ERROR_DRAFT_HEADER)).toBe('recorded');
    expect((await second).headers.get(ERROR_DRAFT_HEADER)).toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('answers skipped to both overlapping failures when the first save fails (one save attempt), and the next failure saves', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release!: (value: unknown) => void;
    const receive = vi.fn().mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValue({ ok: true });
    const { app, report } = build(receive);
    const first = app.request('/api/boom');
    const second = app.request('/api/boom');
    await vi.waitFor(() => { expect(report).toHaveBeenCalledTimes(2); });
    expect(receive).toHaveBeenCalledTimes(1);
    release(unsaved);
    expect((await first).headers.get(ERROR_DRAFT_HEADER)).toBe('skipped');
    expect((await second).headers.get(ERROR_DRAFT_HEADER)).toBe('skipped');
    expect(receive).toHaveBeenCalledTimes(1);
    expect((await app.request('/api/boom')).headers.get(ERROR_DRAFT_HEADER)).toBe('recorded');
    expect(receive).toHaveBeenCalledTimes(2);
  });
});
