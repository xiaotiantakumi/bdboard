import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { BdError } from '../../application/ports/issue-repository.js';
import { respondBdError } from './bd-error-response.js';

async function runRespond(error: unknown): Promise<{ status: number; body: unknown }> {
  const app = new Hono();
  app.get('/', (c) => respondBdError(c, 'failed to test', error));

  const res = await app.request('http://localhost/');
  return { status: res.status, body: await res.json() };
}

describe('respondBdError', () => {
  it('returns 502 with BdError.detail', async () => {
    const result = await runRespond(
      new BdError('lock-contention', 'bdboard-a', 'database is locked'),
    );

    expect(result).toEqual({
      status: 502,
      body: { error: 'failed to test', detail: 'database is locked' },
    });
  });

  it('returns 502 with Error.message for non-BdError throws', async () => {
    const result = await runRespond(new Error('something went wrong'));

    expect(result).toEqual({
      status: 502,
      body: { error: 'failed to test', detail: 'something went wrong' },
    });
  });

  it('stringifies non-Error throws', async () => {
    const result = await runRespond('boom');

    expect(result).toEqual({
      status: 502,
      body: { error: 'failed to test', detail: 'boom' },
    });
  });
});
