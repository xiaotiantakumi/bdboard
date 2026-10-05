import { describe, expect, it } from 'vitest';
import { assertReadOnlyGhApiArgs } from './gh-api-readonly.js';

const ENDPOINT = 'repos/o/r/issues?state=open&per_page=100&page=1';

// 許可する形ちょうど: api --method GET --hostname github.com <endpoint> --jq <jq>
const ALLOWED = ['api', '--method', 'GET', '--hostname', 'github.com', ENDPOINT, '--jq', '.[] | @json'];

describe('assertReadOnlyGhApiArgs', () => {
  it('accepts exactly the allowed read-only shape', () => {
    expect(() => assertReadOnlyGhApiArgs(ALLOWED)).not.toThrow();
    expect(() =>
      assertReadOnlyGhApiArgs(['api', '--method', 'GET', '--hostname', 'github.com',
        'repos/owner/my.repo_1-x/issues?state=open&per_page=100&page=3', '--jq', '.']),
    ).not.toThrow();
  });

  // 許可リスト: 禁止リストに載っていない形 (ヘッダでのメソッド上書き、別ホスト、別の経路、
  // 余分な引数、順序違い) も、許可する形ちょうどでなければ拒否する。
  it.each<[string, string[]]>([
    ['a method override header', [...ALLOWED, '-H', 'X-HTTP-Method-Override: POST']],
    ['a long header flag', [...ALLOWED, '--header', 'X-HTTP-Method-Override: DELETE']],
    ['a missing --hostname', ['api', '--method', 'GET', ENDPOINT, '--jq', '.']],
    ['another host', ['api', '--method', 'GET', '--hostname', 'ghe.example.com', ENDPOINT, '--jq', '.']],
    ['an extra --paginate', [...ALLOWED, '--paginate']],
    ['an extra trailing argument', [...ALLOWED, 'extra']],
    ['a changed order', ['api', '--hostname', 'github.com', '--method', 'GET', ENDPOINT, '--jq', '.']],
    ['a missing --jq', ['api', '--method', 'GET', '--hostname', 'github.com', ENDPOINT]],
    ['an empty jq', ['api', '--method', 'GET', '--hostname', 'github.com', ENDPOINT, '--jq', '']],
    ['the graphql endpoint', ['api', '--method', 'GET', '--hostname', 'github.com', 'graphql', '--jq', '.']],
    ['another repos path', ['api', '--method', 'GET', '--hostname', 'github.com', 'repos/o/r/issues/1/comments', '--jq', '.']],
    ['a closed-issue query', ['api', '--method', 'GET', '--hostname', 'github.com', 'repos/o/r/issues?state=all&per_page=100&page=1', '--jq', '.']],
    ['a path-like owner', ['api', '--method', 'GET', '--hostname', 'github.com', 'repos/../r/issues?state=open&per_page=100&page=1', '--jq', '.']],
    ['an extra query parameter', ['api', '--method', 'GET', '--hostname', 'github.com', `${ENDPOINT}&x=1`, '--jq', '.']],
  ])('rejects %s', (_name, args) => {
    expect(() => assertReadOnlyGhApiArgs(args)).toThrow(/allowed read-only shape/);
  });

  it.each([
    ['-f'],
    ['-F'],
    ['--field'],
    ['--raw-field'],
    ['--input'],
    ['--field=key=value'],
    ['--raw-field=key=value'],
    ['--input=body.json'],
    ['-fkey=value'],
    ['-Fkey=value'],
    ['-if'],
  ])('rejects the write flag %s even next to --method GET', (flag) => {
    expect(() =>
      assertReadOnlyGhApiArgs(['api', '--method', 'GET', ENDPOINT, flag, 'key=value']),
    ).toThrow(/write argument is forbidden/);
  });

  it.each([
    [['api', '-X', 'GET', ENDPOINT]],
    [['api', '-XPOST', ENDPOINT]],
    [['api', '--method', 'POST', ENDPOINT]],
    [['api', '--method', 'get', ENDPOINT]],
    [['api', '--method=GET', ENDPOINT]],
    [['api', '--method', 'GET', '--method', 'GET', ENDPOINT]],
    [['api', ENDPOINT]],
    [['api', ENDPOINT, '--method']],
  ])('rejects %j (needs exactly one "--method GET")', (args) => {
    expect(() => assertReadOnlyGhApiArgs(args)).toThrow();
  });

  // 上の -X / --method= の行は「--method GET が無い」側でも落ちるので、それだけでは -X と
  // --method= の検出を固定できない。gh (pflag) は同じフラグの最後の値を採るため、正しい
  // --method GET の後ろに置かれた上書きが POST に化ける形。前に置いた行は束ね (-iX) と
  // 置き場所に依らず拒否することの確認。
  it.each([
    [['api', '--method', 'GET', ENDPOINT, '-X', 'POST']],
    [['api', '--method', 'GET', ENDPOINT, '-XPOST']],
    [['api', '-iX', 'DELETE', '--method', 'GET', ENDPOINT]],
  ])('rejects -X next to a valid "--method GET": %j', (args) => {
    expect(() => assertReadOnlyGhApiArgs(args)).toThrow(/write argument is forbidden: -/);
  });

  it.each([
    [['api', '--method', 'GET', ENDPOINT, '--method=POST']],
    [['api', '--method=PATCH', '--method', 'GET', ENDPOINT]],
  ])('rejects --method=… next to a valid "--method GET": %j', (args) => {
    expect(() => assertReadOnlyGhApiArgs(args)).toThrow(/exactly one "--method GET"/);
  });

  it('rejects a command that is not gh api', () => {
    expect(() => assertReadOnlyGhApiArgs(['pr', '--method', 'GET'])).toThrow(/begin with "api"/);
    expect(() => assertReadOnlyGhApiArgs([])).toThrow();
  });
});
