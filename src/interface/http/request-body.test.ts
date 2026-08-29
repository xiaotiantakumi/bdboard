import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { INVALID_REQUEST_BODY, parseJsonBody } from './request-body.js';

const bodySchema = z.object({
  name: z.string().min(1),
});

async function runParse(
  request: Request,
  options?: { includeValidationDetails?: boolean; optionalBody?: boolean },
): Promise<{ status: number; body: unknown; parsed?: { ok: true; data: { name: string } } }> {
  const app = new Hono();
  app.post('/', async (c) => {
    const parsed = await parseJsonBody(c, bodySchema, options);
    if (!parsed.ok) {
      return parsed.response;
    }
    return c.json({ ok: true, name: parsed.data.name });
  });

  const res = await app.request(request);
  const json = await res.json();
  if (res.status === 200) {
    return { status: res.status, body: json, parsed: { ok: true, data: { name: (json as { name: string }).name } } };
  }
  return { status: res.status, body: json };
}

describe('parseJsonBody', () => {
  it('returns parsed data for valid JSON and schema', async () => {
    const result = await runParse(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice' }),
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, name: 'alice' });
  });

  it('returns 400 with unified error for invalid JSON', async () => {
    const result = await runParse(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: INVALID_REQUEST_BODY });
  });

  it('returns 400 with unified error for schema validation failure', async () => {
    const result = await runParse(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      }),
    );

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: INVALID_REQUEST_BODY });
  });

  it('includes validation details when requested', async () => {
    const app = new Hono();
    app.post('/', async (c) => {
      const parsed = await parseJsonBody(c, bodySchema, {
        includeValidationDetails: true,
      });
      if (!parsed.ok) {
        return parsed.response;
      }
      return c.json(parsed.data);
    });

    const res = await app.request(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; details: unknown };
    expect(json.error).toBe(INVALID_REQUEST_BODY);
    expect(json.details).toBeDefined();
  });

  it('treats empty body as {} when optionalBody is set', async () => {
    const optionalSchema = z.object({ agentId: z.string().optional() });
    const app = new Hono();
    app.post('/', async (c) => {
      const parsed = await parseJsonBody(c, optionalSchema, { optionalBody: true });
      if (!parsed.ok) {
        return parsed.response;
      }
      return c.json(parsed.data);
    });

    const res = await app.request(
      new Request('http://localhost/', { method: 'POST' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('returns 400 for invalid JSON when optionalBody is set', async () => {
    const optionalSchema = z.object({ agentId: z.string().optional() });
    const app = new Hono();
    app.post('/', async (c) => {
      const parsed = await parseJsonBody(c, optionalSchema, { optionalBody: true });
      if (!parsed.ok) {
        return parsed.response;
      }
      return c.json(parsed.data);
    });

    const res = await app.request(
      new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{bad',
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: INVALID_REQUEST_BODY });
  });
});
