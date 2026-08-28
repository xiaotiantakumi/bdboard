import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  evaluateUpdateCheck,
  parseSemver,
  type Semver,
} from './update-check.js';

function parse(input: string): Semver {
  const parsed = parseSemver(input);
  if (parsed === null) {
    throw new Error(`expected ${input} to parse`);
  }
  return parsed;
}

describe('parseSemver', () => {
  it('accepts a plain version', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
  });

  it('accepts the leading v that GitHub release tags use', () => {
    expect(parseSemver('v1.2.3')).toEqual(parseSemver('1.2.3'));
  });

  it('splits prerelease identifiers, keeping numeric ones as numbers', () => {
    // 数値識別子と英数字識別子は比較規則が違う (SemVer 11.4.1/11.4.2) ので、
    // パース時点で型を分けておく必要がある。
    expect(parseSemver('1.2.3-rc.1')?.prerelease).toEqual(['rc', 1]);
    expect(parseSemver('1.2.3-alpha.beta')?.prerelease).toEqual(['alpha', 'beta']);
  });

  it('accepts but discards build metadata (it does not affect precedence)', () => {
    expect(parseSemver('1.2.3+build.5')).toEqual(parseSemver('1.2.3'));
  });

  it.each([
    ['not a version', 'nightly'],
    ['missing patch', '1.2'],
    ['leading zero', '01.2.3'],
    ['empty prerelease identifier', '1.2.3-a..b'],
    ['trailing dash with nothing after it', '1.2.3-'],
    ['empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(parseSemver(input)).toBeNull();
  });
});

describe('compareSemver', () => {
  it.each([
    ['major', '1.0.0', '2.0.0'],
    ['minor', '1.1.0', '1.2.0'],
    ['patch', '1.1.1', '1.1.2'],
    ['prerelease is older than the release', '1.0.0-rc.1', '1.0.0'],
    ['numeric prerelease identifiers compare numerically', '1.0.0-rc.9', '1.0.0-rc.10'],
    ['numeric identifiers sort before alphanumeric ones', '1.0.0-1', '1.0.0-alpha'],
    ['more identifiers wins when the prefix is equal', '1.0.0-rc', '1.0.0-rc.1'],
  ])('%s: %s < %s', (_label, smaller, larger) => {
    expect(compareSemver(parse(smaller), parse(larger))).toBeLessThan(0);
    expect(compareSemver(parse(larger), parse(smaller))).toBeGreaterThan(0);
  });

  it('treats equal versions as equal, ignoring the v prefix', () => {
    expect(compareSemver(parse('1.2.3'), parse('v1.2.3'))).toBe(0);
  });

  it('sorts a realistic release sequence', () => {
    const versions = ['1.0.0', '1.0.0-rc.10', '0.9.9', '1.0.1', '1.0.0-rc.2'];
    const sorted = [...versions].sort((a, b) => compareSemver(parse(a), parse(b)));
    expect(sorted).toEqual(['0.9.9', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0', '1.0.1']);
  });
});

describe('evaluateUpdateCheck', () => {
  const release = (tag: string) => ({
    tag,
    url: `https://github.com/xiaotiantakumi/bdboard/releases/tag/${tag}`,
  });

  it('reports an update when the latest release is newer', () => {
    expect(evaluateUpdateCheck('1.0.0', release('v1.1.0'))).toEqual({
      kind: 'update-available',
      currentVersion: '1.0.0',
      latestVersion: 'v1.1.0',
      releaseUrl: 'https://github.com/xiaotiantakumi/bdboard/releases/tag/v1.1.0',
    });
  });

  it('reports up-to-date when the versions match apart from the tag prefix', () => {
    expect(evaluateUpdateCheck('1.0.0', release('v1.0.0'))).toEqual({
      kind: 'up-to-date',
      currentVersion: '1.0.0',
    });
  });

  it('reports up-to-date, not a downgrade, when the running build is ahead of the release', () => {
    // リリース前の版をローカルで動かしている状況。「古い版に戻せます」は無意味。
    expect(evaluateUpdateCheck('1.2.0', release('v1.1.0'))).toEqual({
      kind: 'up-to-date',
      currentVersion: '1.2.0',
    });
  });

  it('treats a prerelease build as older than the matching final release', () => {
    expect(evaluateUpdateCheck('1.0.0-rc.1', release('v1.0.0'))).toMatchObject({
      kind: 'update-available',
      latestVersion: 'v1.0.0',
    });
  });

  it('is unknown when the release could not be fetched', () => {
    expect(evaluateUpdateCheck('1.0.0', null)).toEqual({
      kind: 'unknown',
      currentVersion: '1.0.0',
    });
  });

  it.each([
    ['the release tag is not a semver', '1.0.0', 'nightly'],
    ['the running version is not a semver', 'dev', 'v1.0.0'],
  ])('is unknown when %s', (_label, current, tag) => {
    expect(evaluateUpdateCheck(current, release(tag))).toEqual({
      kind: 'unknown',
      currentVersion: current,
    });
  });
});
