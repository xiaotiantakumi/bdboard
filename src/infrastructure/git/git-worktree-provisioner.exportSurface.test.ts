import { describe, expect, it } from 'vitest';
import * as gitWorktreeProvisioner from './git-worktree-provisioner.js';

/**
 * bdboard-sso1.21: src/infrastructure/git/git-worktree-provisioner.ts を機能別モジュール
 * (./git-worktree-provisioner/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の git-worktree-provisioner.ts) から
 * `grep -nE '^export ' src/infrastructure/git/git-worktree-provisioner.ts` で機械的に
 * 採取した値エクスポート名 (6件) をそのままハードコードしている。`export interface` は
 * TypeScript の型のみの宣言で実行時のバインディングを持たない (コンパイルで消える) ため、
 * `Object.keys()` には現れずこのリストにも含めていない — 型エクスポート面は
 * git-worktree-provisioner-type-export-surface.check.ts が tsc (`npm run build`) で固定する
 * (dto.ts 分割, PR #540 / bd-cli-human-decisions.ts 分割, PR #555 と同じ方式)。
 *
 * 分割後の git-worktree-provisioner.ts は factory 本体 (createGitWorktreeProvisioner) と
 * 各サブモジュールからの named re-export のみになる。ここが崩れる (関数の移し忘れ・名前の
 * 変更・re-export の欠落、または内部ヘルパーの意図しない re-export による面の拡大) と、
 * この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = [
  'DEFAULT_MAX_MANAGED_WORKTREES',
  'WORKTREE_BRANCH_MISMATCH_EXPECTED',
  'WORKTREE_BRANCH_MISMATCH_ON_BRANCH',
  'createGitWorktreeProvisioner',
  'formatWorktreeBranchMismatchMessage',
  'normalizePathForComparison',
].sort();

describe('git-worktree-provisioner.ts export surface (bdboard-sso1.21 module split regression guard)', () => {
  it('re-exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(gitWorktreeProvisioner).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
