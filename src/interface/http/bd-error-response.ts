import type { Context } from 'hono';
import { BdError } from '../../application/ports/issue-repository.js';

/** Map a bd-layer failure (or unexpected throw) to the standard 502 JSON envelope. */
export function respondBdError(
  c: Context,
  label: string,
  error: unknown,
): Response {
  const detail =
    error instanceof BdError
      ? error.detail
      : error instanceof Error
        ? error.message
        : String(error);
  return c.json({ error: label, detail }, 502);
}
