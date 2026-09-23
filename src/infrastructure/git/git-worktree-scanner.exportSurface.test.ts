import { describe, expect, it } from 'vitest';
import * as gitWorktreeScanner from './git-worktree-scanner.js';

/**
 * bdboard-sso1.49: src/infrastructure/git/git-worktree-scanner.ts を機能別モジュール
 * (./git-worktree-scanner/*.ts) へ分割した際の、実行時エクスポート面の回帰ガード。
 *
 * このリストは分割前 (分割 PR のベース、main の git-worktree-scanner.ts) から
 * `grep -nE '^export ' src/infrastructure/git/git-worktree-scanner.ts` で機械的に
 * 採取した値エクスポート名 (1件) をそのままハードコードしている。`export interface` は
 * TypeScript の型のみの宣言で実行時のバインディングを持たない (コンパイルで消える) ため、
 * `Object.keys()` には現れずこのリストにも含めていない — 型エクスポート面は
 * git-worktree-scanner-type-export-surface.check.ts が tsc (`npm run build`) で固定する
 * (dto.ts 分割, PR #540 / git-worktree-provisioner.ts 分割, PR #567 と同じ方式)。
 *
 * 分割後の git-worktree-scanner.ts は factory 本体 (createGitWorktreeScanner) のみになる。
 * ここが崩れる (関数の移し忘れ・名前の変更・内部ヘルパーの意図しない export による面の
 * 拡大) と、この一覧との差分としてすぐ検出できる。
 */
const EXPECTED_VALUE_EXPORTS = ['createGitWorktreeScanner'].sort();

describe('git-worktree-scanner.ts export surface (bdboard-sso1.49 module split regression guard)', () => {
  it('exports exactly the same runtime bindings as the pre-split file', () => {
    const actual = Object.keys(gitWorktreeScanner).sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });
});
