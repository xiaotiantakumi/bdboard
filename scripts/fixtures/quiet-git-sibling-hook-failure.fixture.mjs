// bdboard-sl0n: scripts/test-support/quiet-git.test.mjs が「子の vitest」として流す題材 (このファイル自身は *.test.mjs ではないので
// リポジトリの vitest.config.ts の include には入らず、単独では走らない)。useQuietGitProcessEnv の復元のケース B:
// 同じ suite で、useQuietGitProcessEnv の後に登録された別の beforeAll が失敗しても、process.env.GIT_CONFIG_GLOBAL が元の値に戻り、
// 一時の gitconfig の dir も消えること。beforeAll を失敗させるとそのファイルが失敗扱いになるので、親のテストが子のプロセスとして
// 流し、結果 (JSON reporter) を読む。親は (1) ファイルが失敗扱いで 'sibling beforeAll registered after it fails' は走らない (skipped。
// = 失敗を起こせた)、(2) 'restores GIT_CONFIG_GLOBAL ...' が成功 (= 復元できた) を見る。
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { useQuietGitProcessEnv } from '../test-support/quiet-git.mjs';

const SENTINEL = '/sentinel/original-global-config';
process.env.GIT_CONFIG_GLOBAL = SENTINEL;

/** 失敗する beforeAll の中 (= useQuietGitProcessEnv の beforeAll の後) で見えた GIT_CONFIG_GLOBAL。 */
let seenInSiblingHook;

describe('case B: a sibling beforeAll registered after it fails', () => {
  useQuietGitProcessEnv();
  beforeAll(() => {
    seenInSiblingHook = process.env.GIT_CONFIG_GLOBAL;
    throw new Error('sibling beforeAll failed');
  });
  it('sibling beforeAll registered after it fails', () => {});
});

describe('after the failed suite', () => {
  it('restores GIT_CONFIG_GLOBAL and removes the temporary gitconfig directory', () => {
    // 失敗する beforeAll の時点では静かな設定に向いていた (補助の beforeAll が先に走った) ことが前提。
    expect(seenInSiblingHook).toBeTypeOf('string');
    expect(seenInSiblingHook).not.toBe(SENTINEL);
    expect(existsSync(seenInSiblingHook)).toBe(false);
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(SENTINEL);
  });
});
