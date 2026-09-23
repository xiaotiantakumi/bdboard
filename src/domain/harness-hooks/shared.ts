// bdboard-sso1.66: harness-hooks.ts の分割で、./merge.ts (mergeHarnessHooks) と
// ./evaluate.ts (evaluateHooksState) の両方が使う非公開ヘルパーをここへ集約する。
// 分割前は同一ファイル内の非公開 (export なし) 定義だったが、モジュール境界を跨ぐため
// export を付けている。公開エクスポート面 (../harness-hooks.ts) には出さない。
import type { JsonObject } from './types.js';

export const HOOKS_KEY = 'hooks';
export const COMMAND_HOOK_TYPE = 'command';

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
