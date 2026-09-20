import { describe, expect, it } from 'vitest';
import * as claudeRunner from './claude-runner.js';

/**
 * bdboard-sso1.29: src/infrastructure/runners/claude-runner.ts を機能別モジュール
 * (./claude-runner/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の claude-runner.ts) から
 * `grep -nE '^export ' src/infrastructure/runners/claude-runner.ts` で機械的に
 * 採取した値エクスポート名 (8件) をそのままハードコードしている。`export interface` は
 * TypeScript の型のみの宣言で実行時のバインディングを持たない (コンパイルで消える) ため、
 * `Object.keys()` には現れずこのリストにも含めていない — 型エクスポート面は
 * claude-runner-type-export-surface.check.ts が tsc (`npm run build`) で固定する
 * (dto.ts 分割, PR #540 / git-worktree-provisioner.ts 分割, PR #567 と同じ方式)。
 *
 * 分割後の claude-runner.ts は各サブモジュールからの named re-export のみになる。
 * ここが崩れる (関数の移し忘れ・名前の変更・re-export の欠落、または内部ヘルパーの
 * 意図しない re-export による面の拡大) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'ALLOWED_BASH_WILDCARD_VERBS',
  'DEFAULT_ALLOWED_TOOLS',
  'DEFAULT_SETTING_SOURCES',
  'DENIED_TOOLS',
  'buildRunnerEnv',
  'clearWorktreeLocalClaudeSettings',
  'createClaudeRunner',
  'resetClaudeVersionCacheForTests',
].sort();

describe('claude-runner.ts export surface (bdboard-sso1.29 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(claudeRunner).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
