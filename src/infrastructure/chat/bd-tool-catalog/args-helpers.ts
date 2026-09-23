// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、buildBdToolArgs の各
// *-tools.ts builder が共通で使う結果ヘルパー (reject/ok の BdArgsBuildResult 組み立て、
// zod エラーの要約、bd CLI 引数の readonly/write 接頭辞)。挙動・型は分割前と同一 (移動のみ、
// module-private だった各関数に export を付けただけ)。
//
// describeZodError は bdboard-sso1.75 で ../zod-error-summary.ts へ寄せた (repo-tool-catalog
// にも同一定義があったため)。このファイルの5つの呼び出し元 (*-tools.ts) を変えずに済むよう、
// ここでは re-export のみ行う。
import type { BdArgsBuildResult } from './types.js';

export { describeZodError } from '../zod-error-summary.js';

export function reject(error: string): BdArgsBuildResult {
  return { ok: false, error };
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
