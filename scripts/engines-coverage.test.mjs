// bdboard-ugt1: package.json の engines.node (verify の版ガードが読む値) が、ルートと web の
// 直接依存が宣言する engines.node を満たしているかを検査する。
//
// 22.9.0 のまま、ルートの vite 7 (22.x では >=22.12.0 を要求) を入れて、22.9〜22.11 で版ガードを
// 素通りしていた。依存を上げたときに同じズレを CI で拾うためのテスト。engines の具体値や依存名は
// ハードコードしない — 正本は package.json とコミット済みの lockfile。
//
// 範囲:
// - 直接依存 (dependencies + devDependencies) だけを見る。推移依存には rollup の optional な
//   プラットフォーム別バイナリのように、特定 OS/CPU でしか入らず engines の厳しいものがあり、
//   それらに下限を合わせると利用者を不要に締め出すため対象外にしている。
// - 検査するのは「engines.node の下限そのものを各依存が受け付けるか」。下限より上の major の穴
//   (例: vitest 4 は 23.x を含まない) は見ない — 版ガードは ">=X.Y.Z" しか表現できず、
//   穴は EOL の奇数版で起きるため。
// - engines は node_modules ではなく lockfile (packages["node_modules/<name>"].engines) から読む。
//   install の状態 (web 未 install・古い node_modules) で偽の合格にならないようにする。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseMinimumRange, satisfiesMinimum } from './node-version-guard.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- npm semver の range を区間の和として解釈する最小実装 ------------------------------
// 版は { major, minor, patch }。区間は下限を含み上限を含まない [lo, hi) に正規化する
// (hi === null は上限なし)。プレリリース・ハイフン範囲 (a - b) は扱わず throw する
// — 解釈できない engines を黙って合格にしない。

const ZERO = { major: 0, minor: 0, patch: 0 };
const compareVersions = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
const maxVersion = (a, b) => (compareVersions(a, b) >= 0 ? a : b);
const minUpper = (a, b) => (a === null ? b : b === null ? a : compareVersions(a, b) <= 0 ? a : b);
const formatVersion = (v) => `${v.major}.${v.minor}.${v.patch}`;

// "22" / "22.12" / "22.12.0" / "22.x" / "*" を { major, minor, patch, parts } に。parts は
// 明示された桁数 (ワイルドカード以降は省略扱い、"*" は 0)。
function parsePartial(text) {
  const segments = text.split('.');
  if (segments.length > 3) return null;
  const numbers = [];
  for (const segment of segments) {
    if (/^[xX*]$/.test(segment)) break;
    if (!/^\d+$/.test(segment)) return null;
    numbers.push(Number(segment));
  }
  return { major: numbers[0] ?? 0, minor: numbers[1] ?? 0, patch: numbers[2] ?? 0, parts: numbers.length };
}

// 省略された桁の次の単位 (22 → 23.0.0、22.12 → 22.13.0、22.12.3 → 22.12.4)。
function nextUnit(p) {
  if (p.parts <= 1) return { major: p.major + 1, minor: 0, patch: 0 };
  if (p.parts === 2) return { major: p.major, minor: p.minor + 1, patch: 0 };
  return { major: p.major, minor: p.minor, patch: p.patch + 1 };
}

const ANY = { lo: ZERO, hi: null };
const EMPTY = { lo: ZERO, hi: ZERO };

function comparatorInterval(operator, p) {
  const floor = { major: p.major, minor: p.minor, patch: p.patch };
  if (p.parts === 0) {
    // "*" / ">=*" / "<=*" は全版、">*" / "<*" はどの版も満たさない (npm semver と同じ)。
    return operator === '>' || operator === '<' ? EMPTY : ANY;
  }
  switch (operator) {
    case '':
    case '=':
      return { lo: floor, hi: nextUnit(p) };
    case '>=':
      return { lo: floor, hi: null };
    case '>':
      return { lo: nextUnit(p), hi: null };
    case '<':
      return { lo: ZERO, hi: floor };
    case '<=':
      return { lo: ZERO, hi: nextUnit(p) };
    case '~':
      return { lo: floor, hi: nextUnit({ ...p, parts: Math.min(p.parts, 2) }) };
    case '^': {
      // 左端の 0 でない桁 (省略された桁は 0 でないとみなさない) の次を上限にする。
      const significant = p.major > 0 || p.parts === 1 ? 1 : p.minor > 0 || p.parts === 2 ? 2 : 3;
      return { lo: floor, hi: nextUnit({ ...p, parts: significant }) };
    }
    default:
      throw new Error(`unsupported operator ${JSON.stringify(operator)}`);
  }
}

const COMPARATOR_RE = /(>=|<=|>|<|=|\^|~)?\s*v?([0-9xX*]+(?:\.[0-9xX*]+){0,2})/g;

function clauseInterval(clause) {
  let interval = ANY;
  let previousEnd = 0;
  for (const match of clause.matchAll(COMPARATOR_RE)) {
    if (clause.slice(previousEnd, match.index).trim() !== '') {
      throw new Error(`unsupported range clause ${JSON.stringify(clause)}`);
    }
    previousEnd = match.index + match[0].length;
    const partial = parsePartial(match[2]);
    if (partial === null) throw new Error(`unsupported comparator ${JSON.stringify(match[0])}`);
    const next = comparatorInterval(match[1] ?? '', partial);
    interval = { lo: maxVersion(interval.lo, next.lo), hi: minUpper(interval.hi, next.hi) };
  }
  if (clause.slice(previousEnd).trim() !== '') {
    throw new Error(`unsupported range clause ${JSON.stringify(clause)}`);
  }
  return interval;
}

function rangeIntervals(range) {
  if (typeof range !== 'string') throw new Error('engines.node is not a string');
  return range.split('||').map((clause) => clauseInterval(clause));
}

const contains = ({ lo, hi }, version) =>
  compareVersions(version, lo) >= 0 && (hi === null || compareVersions(version, hi) < 0);

function satisfiesRange(version, range) {
  return rangeIntervals(range).some((interval) => contains(interval, version));
}

// major 系 (M.0.0 以上 M+1.0.0 未満) の中で range を満たす最小版。無ければ null。
function minimumForRangeInMajor(range, major) {
  const majorInterval = { lo: { major, minor: 0, patch: 0 }, hi: { major: major + 1, minor: 0, patch: 0 } };
  let lowest = null;
  for (const interval of rangeIntervals(range)) {
    const lo = maxVersion(interval.lo, majorInterval.lo);
    const hi = minUpper(interval.hi, majorInterval.hi);
    if (compareVersions(lo, hi) < 0 && (lowest === null || compareVersions(lo, lowest) < 0)) {
      lowest = lo;
    }
  }
  return lowest;
}

const v = (text) => {
  const p = parsePartial(text);
  return { major: p.major, minor: p.minor, patch: p.patch };
};

describe('minimumForRangeInMajor', () => {
  it.each([
    ['^20.19.0 || >=22.12.0', 22, '22.12.0'],
    ['^20.0.0 || ^22.0.0 || >=24.0.0', 22, '22.0.0'],
    ['>= 14.16.0', 22, '22.0.0'],
    ['^18.17||>=20', 22, '22.0.0'],
    ['~22', 22, '22.0.0'],
    ['~22.3', 22, '22.3.0'],
    ['22.x', 22, '22.0.0'],
    ['22.1.x', 22, '22.1.0'],
    ['>=20 <23', 22, '22.0.0'],
    ['>22.12', 22, '22.13.0'],
    ['>=22.12.5 <=22.12', 22, '22.12.5'],
    ['>=v22.12', 22, '22.12.0'],
    ['*', 22, '22.0.0'],
    ['x', 22, '22.0.0'],
    ['', 22, '22.0.0'],
  ])('%j in %i.x is %s', (range, major, expected) => {
    expect(formatVersion(minimumForRangeInMajor(range, major))).toBe(expected);
  });

  it.each([
    ['^20.0.0 || >=24', 22],
    ['>=20 <22', 22],
    ['~21', 22],
    ['>22', 22],
    ['<=21', 22],
    ['>*', 22],
  ])('%j has no version in %i.x', (range, major) => {
    expect(minimumForRangeInMajor(range, major)).toBeNull();
  });

  it('throws on ranges it cannot interpret instead of passing silently', () => {
    expect(() => minimumForRangeInMajor('^20 || latest', 22)).toThrow(/unsupported/);
    expect(() => minimumForRangeInMajor('>=22.0.0-rc.1', 22)).toThrow(/unsupported/);
    expect(() => minimumForRangeInMajor('20 - 22', 22)).toThrow(/unsupported/);
  });
});

describe('satisfiesRange', () => {
  it('follows npm semver bounds, including holes between majors', () => {
    expect(satisfiesRange(v('22.12.0'), '^20.19.0 || >=22.12.0')).toBe(true);
    expect(satisfiesRange(v('22.11.9'), '^20.19.0 || >=22.12.0')).toBe(false);
    expect(satisfiesRange(v('23.0.0'), '^20.0.0 || ^22.0.0 || >=24.0.0')).toBe(false);
    expect(satisfiesRange(v('22.99.0'), '~22')).toBe(true);
    expect(satisfiesRange(v('22.4.0'), '~22.3')).toBe(false);
    expect(satisfiesRange(v('0.2.9'), '^0.2.3')).toBe(true);
    expect(satisfiesRange(v('0.3.0'), '^0.2.3')).toBe(false);
  });
});

describe('root Node engines coverage', () => {
  const readJson = (...segments) => JSON.parse(fs.readFileSync(path.join(repoRoot, ...segments), 'utf8'));
  const range = readJson('package.json').engines?.node;
  const minimum = parseMinimumRange(range);

  it('accepts its declared lower bound, its v-prefixed form, and rejects the preceding version', () => {
    expect(minimum).not.toBeNull();
    const current = formatVersion(minimum);
    const previous = minimum.patch > 0
      ? { ...minimum, patch: minimum.patch - 1 }
      : minimum.minor > 0
        ? { major: minimum.major, minor: minimum.minor - 1, patch: 99 }
        : { major: minimum.major - 1, minor: 99, patch: 99 };
    expect(satisfiesMinimum(current, range)).toBe(true);
    expect(satisfiesMinimum(`v${current}`, range)).toBe(true);
    expect(satisfiesMinimum(formatVersion(previous), range)).toBe(false);
  });

  it('is accepted by the Node engines of every direct dependency (read from the lockfiles)', () => {
    expect(minimum).not.toBeNull();
    const failures = [];
    let inspected = 0;
    for (const packageDir of ['.', 'web']) {
      const pkg = readJson(packageDir, 'package.json');
      const lock = readJson(packageDir, 'package-lock.json');
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const entry = lock.packages?.[`node_modules/${name}`];
        if (entry === undefined) {
          failures.push(`${packageDir}/${name}: not in ${packageDir}/package-lock.json (lockfile out of sync?)`);
          continue;
        }
        const required = entry.engines?.node;
        if (typeof required !== 'string') continue;
        inspected += 1;
        const label = `${packageDir}/${name}@${entry.version}: ${required}`;
        try {
          if (!satisfiesRange(minimum, required)) {
            const lowest = minimumForRangeInMajor(required, minimum.major);
            failures.push(
              `${label} (rejects ${formatVersion(minimum)}; lowest accepted on ${minimum.major}.x is ${lowest === null ? 'none' : formatVersion(lowest)})`,
            );
          }
        } catch (error) {
          failures.push(`${label} (${error.message})`);
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
