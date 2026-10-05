import { describe, expect, it } from 'vitest';
import { assertReadOnlyGhApiArgs } from './gh-api-readonly.js';

const ENDPOINT = 'repos/o/r/issues?state=open&per_page=100&page=1';

describe('assertReadOnlyGhApiArgs', () => {
  it('accepts a GET api call', () => {
    expect(() =>
      assertReadOnlyGhApiArgs(['api', '--method', 'GET', ENDPOINT, '--jq', '.[] | @json']),
    ).not.toThrow();
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

  it('rejects a command that is not gh api', () => {
    expect(() => assertReadOnlyGhApiArgs(['pr', '--method', 'GET'])).toThrow(/begin with "api"/);
    expect(() => assertReadOnlyGhApiArgs([])).toThrow();
  });
});
