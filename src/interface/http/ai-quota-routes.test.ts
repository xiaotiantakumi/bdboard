import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AiQuotaService, AiQuotaState } from '../../application/ai-quota/get-ai-quota.js';
import { createAiQuotaRoutes } from './ai-quota-routes.js';

function createApp(state: AiQuotaState): { app: Hono; service: AiQuotaService } {
  const service: AiQuotaService = {
    getSnapshot: vi.fn(async () => state),
    peekSnapshot: vi.fn(() => state),
  };
  const app = new Hono();
  app.route('/', createAiQuotaRoutes({ aiQuotaService: service }));
  return { app, service };
}

describe('GET /api/ai-quota', () => {
  it('returns structured provider metrics on success', async () => {
    const { app } = createApp({
      kind: 'ok',
      fetchedAt: new Date('2026-08-15T00:00:00.000Z'),
      providers: [
        {
          id: 'agy',
          label: 'Antigravity (Gemini sub)',
          vendor: 'Google',
          plan: 'Google AI Pro',
          availability: 'live',
          metrics: [
            {
              label: 'Weekly Limit Remaining',
              percentRemaining: 92,
              resetInText: '88h 21m',
              resetAt: new Date('2026-08-18T16:21:00.000Z'),
            },
            { label: 'Credits', valueText: '25 credits' },
          ],
        },
        {
          id: 'cursor',
          label: 'Cursor (cursor-agent)',
          vendor: 'Anysphere',
          availability: 'manual',
          detail: '自動取得未対応。Settings → Usage で確認。',
          metrics: [],
        },
      ],
    });

    const res = await app.request('/api/ai-quota');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      state: 'ok',
      fetchedAt: '2026-08-15T00:00:00.000Z',
      providers: [
        {
          id: 'agy',
          label: 'Antigravity (Gemini sub)',
          vendor: 'Google',
          plan: 'Google AI Pro',
          availability: 'live',
          metrics: [
            {
              label: 'Weekly Limit Remaining',
              percentRemaining: 92,
              resetInText: '88h 21m',
              resetAt: '2026-08-18T16:21:00.000Z',
            },
            { label: 'Credits', valueText: '25 credits' },
          ],
        },
        {
          id: 'cursor',
          label: 'Cursor (cursor-agent)',
          vendor: 'Anysphere',
          availability: 'manual',
          detail: '自動取得未対応。Settings → Usage で確認。',
          metrics: [],
        },
      ],
    });
  });

  it('returns a gentle error payload (still 200) when the service reports an error state', async () => {
    const { app } = createApp({ kind: 'error', message: 'ai-quota exited with code 127' });

    const res = await app.request('/api/ai-quota');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ state: 'error', message: 'ai-quota exited with code 127' });
  });

  it('never includes account/email fields even if somehow present upstream', async () => {
    const { app } = createApp({
      kind: 'ok',
      fetchedAt: new Date('2026-08-15T00:00:00.000Z'),
      providers: [
        {
          id: 'agy',
          label: 'Antigravity (Gemini sub)',
          availability: 'live',
          metrics: [{ label: 'Weekly Limit Remaining', percentRemaining: 92 }],
        },
      ],
    });

    const res = await app.request('/api/ai-quota');
    const body = (await res.json()) as { providers: Array<Record<string, unknown>> };
    const keys = Object.keys(body.providers[0]);
    expect(keys).not.toContain('account');
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });
});
