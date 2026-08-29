import type { Context } from 'hono';
import { z, type ZodType } from 'zod';

/** Shared 400 body error string for JSON parse and schema validation failures. */
export const INVALID_REQUEST_BODY = 'invalid request body';

export type ParseJsonBodyOptions = {
  /** Include Zod flatten() on schema validation failure. */
  includeValidationDetails?: boolean;
  /** Read via text(); empty body is treated as {} before parsing. */
  optionalBody?: boolean;
};

export type ParseJsonBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

function invalidBodyResponse(
  c: Context,
  options?: { details?: unknown },
): Response {
  if (options?.details !== undefined) {
    return c.json(
      { error: INVALID_REQUEST_BODY, details: options.details },
      400,
    );
  }
  return c.json({ error: INVALID_REQUEST_BODY }, 400);
}

async function readBodyUnknown(
  c: Context,
  optionalBody: boolean,
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  if (optionalBody) {
    let body: unknown = {};
    const rawBody = await c.req.text();
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return { ok: false, response: invalidBodyResponse(c) };
      }
    }
    return { ok: true, body };
  }

  try {
    const body = await c.req.json();
    return { ok: true, body };
  } catch {
    return { ok: false, response: invalidBodyResponse(c) };
  }
}

/**
 * Parse and validate a JSON request body. Returns a typed value or a ready-to-return
 * 400 Response (invalid JSON or schema failure).
 */
export async function parseJsonBody<S extends ZodType<any, any, any>>(
  c: Context,
  schema: S,
  options?: ParseJsonBodyOptions,
): Promise<ParseJsonBodyResult<z.infer<S>>> {
  const readResult = await readBodyUnknown(c, options?.optionalBody ?? false);
  if (!readResult.ok) {
    return readResult;
  }

  const parsed = schema.safeParse(readResult.body);
  if (!parsed.success) {
    const details = options?.includeValidationDetails
      ? parsed.error.flatten()
      : undefined;
    return {
      ok: false,
      response: invalidBodyResponse(c, { details }),
    };
  }

  return { ok: true, data: parsed.data };
}
