import type { z } from 'zod';

/**
 * Summarises a zod failure without echoing model-supplied keys or values back into the
 * rejection message.
 *
 * bdboard-sso1.75: consolidated from two independent copies (bd-tool-catalog/args-helpers.ts and
 * a private one in repo-tool-catalog/args-builder.ts, confirmed byte-identical). Lives here,
 * outside both tool-catalog folders, so neither has to reach into the other's internals -
 * bd-tool-catalog/args-helpers.ts re-exports it for its own five call sites.
 */
export function describeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      const detail =
        issue.code === 'unrecognized_keys' ? 'unrecognized key' : issue.message;
      return path.length > 0 ? `${path}: ${detail}` : detail;
    })
    .join('; ');
}
