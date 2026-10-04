// bdboard-ulxa.3 (PR #854 レビュー): `npm run verify` / `npm run verify -- --light` がどの npm script を走らせるか
// (scripts/verify-steps.mjs) と、package.json の verify:light が「verify:steps からテストを抜いたもの」のままで
// あることのテスト。verify:steps にステップを足して verify:light に足し忘れると、merge-pr の S3 クラス L の
// 軽量チェックが黙ってそのステップを飛ばす。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LIGHT_FLAG, leaderArgsFor, stepsScriptFor } from './verify-steps.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const TEST_STEPS = ['test:server', 'test:web'];

/** "npm run a && npm run b" を ['a', 'b'] にする。その形でないステップがあれば落とす (黙って読み飛ばさない)。 */
function steps(name) {
  const script = pkg.scripts[name];
  expect(typeof script, `package.json scripts.${name}`).toBe('string');
  return script.split('&&').map((step) => {
    const match = /^npm run ([^\s]+)$/.exec(step.trim());
    expect(match, `${name} のステップ "${step.trim()}" は npm run <script> の形ではない`).not.toBeNull();
    return match[1];
  });
}

describe('verify step selection (bdboard-ulxa.3)', () => {
  it('stepsScriptFor: --light picks verify:light, anything else verify:steps', () => {
    expect(LIGHT_FLAG).toBe('--light');
    expect(stepsScriptFor(['node', 'scripts/verify.mjs'])).toBe('verify:steps');
    expect(stepsScriptFor(['node', 'scripts/verify.mjs', '--group-leader'])).toBe('verify:steps');
    expect(stepsScriptFor(['node', 'scripts/verify.mjs', '--light'])).toBe('verify:light');
    expect(stepsScriptFor(['node', 'scripts/verify.mjs', '--group-leader', '--light'])).toBe('verify:light');
    expect(stepsScriptFor(['node', 'scripts/verify.mjs', '--lightweight'])).toBe('verify:steps');
  });

  it('leaderArgsFor: the group leader gets --light too (it picks the script from its own argv)', () => {
    expect(leaderArgsFor(['node', 'scripts/verify.mjs'])).toEqual(['--group-leader']);
    expect(leaderArgsFor(['node', 'scripts/verify.mjs', '--light'])).toEqual(['--group-leader', '--light']);
    // リーダーの argv で振り分けた結果が、外側の argv で振り分けた結果と一致する。
    for (const argv of [['node', 'v'], ['node', 'v', '--light']]) {
      expect(stepsScriptFor(['node', 'v', ...leaderArgsFor(argv)])).toBe(stepsScriptFor(argv));
    }
  });

  it('both scripts the selection can pick exist, and npm run verify goes through scripts/verify.mjs', () => {
    expect(pkg.scripts.verify).toBe('node scripts/verify.mjs');
    for (const argv of [[], ['--light']]) {
      expect(pkg.scripts[stepsScriptFor(argv)]).toEqual(expect.any(String));
    }
  });

  it('package.json: verify:light is exactly verify:steps without test:server / test:web, in the same order', () => {
    const full = steps('verify:steps');
    expect(full).toEqual(expect.arrayContaining(TEST_STEPS));
    expect(steps('verify:light')).toEqual(full.filter((step) => !TEST_STEPS.includes(step)));
  });
});
