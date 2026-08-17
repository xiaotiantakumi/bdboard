import { describe, expect, it, vi } from 'vitest';
import type { AiQuotaSource, AiQuotaSourceResult } from '../ports/ai-quota-source.js';
import { createAiQuotaService } from './get-ai-quota.js';

function createFakeSource(
  fetchImpl: () => Promise<AiQuotaSourceResult>,
): AiQuotaSource & { readonly fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(fetchImpl);
  return { fetch: fetchMock, fetchMock };
}

const SAMPLE_RESULT: AiQuotaSourceResult = {
  fetchedAt: new Date('2026-08-15T00:00:00.000Z'),
  providers: [
    {
      id: 'agy',
      label: 'Antigravity (Gemini sub)',
      metrics: [{ label: 'Weekly Limit Remaining', percentRemaining: 92 }],
    },
  ],
};

describe('createAiQuotaService', () => {
  it('fetches once and caches for the TTL window', async () => {
    let now = new Date('2026-08-15T00:00:00.000Z');
    const source = createFakeSource(async () => SAMPLE_RESULT);
    const service = createAiQuotaService({ source, now: () => now, ttlMs: 5 * 60 * 1000 });

    const first = await service.getSnapshot();
    expect(first.kind).toBe('ok');
    expect(source.fetchMock).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 60_000); // 1min later, still within TTL
    const second = await service.getSnapshot();
    expect(second).toBe(first);
    expect(source.fetchMock).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 5 * 60 * 1000); // now past TTL
    const third = await service.getSnapshot();
    expect(third.kind).toBe('ok');
    expect(source.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls into a single underlying fetch', async () => {
    let resolveFetch: (value: AiQuotaSourceResult) => void = () => {};
    const source = createFakeSource(
      () => new Promise<AiQuotaSourceResult>((resolve) => { resolveFetch = resolve; }),
    );
    const service = createAiQuotaService({ source, now: () => new Date() });

    const p1 = service.getSnapshot();
    const p2 = service.getSnapshot();
    resolveFetch(SAMPLE_RESULT);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(source.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an error state (never throws) when the source fails, and caches the failure too', async () => {
    let now = new Date('2026-08-15T00:00:00.000Z');
    const source = createFakeSource(async () => {
      throw new Error('ai-quota exited with code 127: command not found');
    });
    const service = createAiQuotaService({ source, now: () => now, ttlMs: 60_000 });

    const state = await service.getSnapshot();
    expect(state).toEqual({
      kind: 'error',
      message: 'ai-quota exited with code 127: command not found',
    });
    expect(source.fetchMock).toHaveBeenCalledTimes(1);

    // still within TTL: cached error, no re-fetch
    await service.getSnapshot();
    expect(source.fetchMock).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 61_000);
    await service.getSnapshot();
    expect(source.fetchMock).toHaveBeenCalledTimes(2);
  });
});
