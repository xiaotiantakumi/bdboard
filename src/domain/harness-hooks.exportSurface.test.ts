import { describe, expect, it } from 'vitest';
import * as harnessHooks from './harness-hooks.js';

/**
 * bdboard-sso1.66: src/domain/harness-hooks.ts を関心別モジュール (./harness-hooks/*.ts) へ
 * 分割する際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (このコミット時点) の harness-hooks.ts から
 * `grep -nE '^export (const|function|async function) [A-Za-z0-9_]+' src/domain/harness-hooks.ts`
 * で機械的に採取した値エクスポート名 (8件) をそのままハードコードしている。
 * `export interface` / `export type` は TypeScript の型のみの宣言で実行時のバインディングを
 * 持たない (コンパイルで消える) ため `Object.keys()` には現れずこのリストにも含めていない —
 * 型エクスポート面は harness-hooks-type-export-surface.check.ts が tsc (`npm run build`) で固定する。
 *
 * 分割後の harness-hooks.ts は名前を明示した re-export (harness-kpi.ts の分割 (PR #615) と
 * 同じ方式) のみになる。ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落) と、
 * この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'SETTINGS_RELATIVE_PATH',
  'CLAUDE_PROJECT_DIR_PLACEHOLDER',
  'DEFAULT_PACK_HOOK_TIMEOUT_SECONDS',
  'PACK_HOOKS_DIR',
  'harnessHookMarker',
  'harnessHookCommand',
  'mergeHarnessHooks',
  'evaluateHooksState',
].sort();

describe('harness-hooks.ts export surface (bdboard-sso1.66 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split harness-hooks.ts', () => {
    const actual = Object.keys(harnessHooks).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
