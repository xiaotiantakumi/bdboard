// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、buildBdToolArgs の各
// *-tools.ts builder が共通で使う結果ヘルパー (reject/ok の BdArgsBuildResult 組み立て、
// zod エラーの要約、bd CLI 引数の readonly/write 接頭辞)。挙動・型は分割前と同一 (移動のみ、
// module-private だった各関数に export を付けただけ)。
import type { z } from 'zod';
import type { BdArgsBuildResult } from './types.js';

export function reject(error: string): BdArgsBuildResult {
  return { ok: false, error };
}

/**
 * Summarises a zod failure without echoing model-supplied keys or values back
 * into the rejection message.
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

export function ok(
  args: readonly string[],
  stdin?: string,
): BdArgsBuildResult {
  return {
    ok: true,
    args,
    ...(stdin !== undefined ? { stdin } : {}),
  };
}

export function buildReadonlyPrefix(projectRootPath: string): readonly string[] {
  return ['--readonly', '-C', projectRootPath];
}

export function buildWritePrefix(projectRootPath: string): readonly string[] {
  return ['-C', projectRootPath];
}
