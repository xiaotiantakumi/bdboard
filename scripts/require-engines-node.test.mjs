// bdboard-5st4: require-engines-node.mjs (web の build:web を古い node で成功させない先頭ガード) のテスト。
// 本物の古い node (x86_64 の v14.15.0 は arm64 のローカルでは動かない) は使わず、engines.node を
// 実 node が満たせない値にした使い捨ての repoRoot で「満たさない node」を模す。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { formatNodeShortfall, main } from './require-engines-node.mjs';

const script = fileURLToPath(new URL('./require-engines-node.mjs', import.meta.url));
const webPackageJson = fileURLToPath(new URL('../web/package.json', import.meta.url));

const tempDirs = [];
const makeRepo = ({ engines, nvmrc }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'require-engines-node-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(engines === undefined ? {} : { engines: { node: engines } }));
  if (nvmrc !== undefined) {
    fs.writeFileSync(path.join(dir, '.nvmrc'), `${nvmrc}\n`);
  }
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('main', () => {
  it('passes when the node satisfies engines.node', () => {
    expect(main([makeRepo({ engines: '>=22.0.0' })], '22.14.0')).toEqual({ code: 0, lines: [] });
  });

  it('fails with the required and current versions when the node is too old (the vite exit-0 case)', () => {
    const result = main([makeRepo({ engines: '>=22.12.0', nvmrc: '22' })], '14.15.0');
    expect(result.code).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('>=22.12.0');
    expect(text).toContain('v14.15.0');
    expect(text).toContain('exit 0');
    expect(text).toContain('.nvmrc (= 22)');
    for (const line of result.lines) {
      expect(line.startsWith('build:web: ')).toBe(true);
    }
  });

  it('fails open when engines.node is missing or not a ">=X.Y.Z" range', () => {
    expect(main([makeRepo({})], '14.15.0').code).toBe(0);
    expect(main([makeRepo({ engines: '^22.0.0' })], '14.15.0').code).toBe(0);
  });

  it('defaults to this repository, whose own engines.node the test runner satisfies', () => {
    expect(main([]).code).toBe(0);
  });
});

describe('formatNodeShortfall', () => {
  it('omits the .nvmrc hint when there is no .nvmrc', () => {
    const text = formatNodeShortfall({ current: '14.15.0', required: '>=22.12.0', nvmrc: undefined }).join('\n');
    expect(text).not.toContain('.nvmrc');
    expect(text).toContain('PATH の先頭');
  });
});

describe('command line', () => {
  const run = (repo) => {
    const result = spawnSync(process.execPath, [script, repo], { encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };

  it('exits 1 with the explanation on stderr when engines.node cannot be satisfied', () => {
    const result = run(makeRepo({ engines: '>=999.0.0' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('>=999.0.0');
    expect(result.stderr).toContain(`v${process.versions.node}`);
    expect(result.stdout).toBe('');
  });

  it('exits 0 silently when engines.node is satisfied', () => {
    expect(run(makeRepo({ engines: '>=1.0.0' }))).toEqual({ status: 0, stdout: '', stderr: '' });
  });
});

describe('web/package.json wiring', () => {
  it('runs the guard before tsc and vite in the build script', () => {
    const build = JSON.parse(fs.readFileSync(webPackageJson, 'utf8')).scripts.build;
    expect(build.startsWith('node ../scripts/require-engines-node.mjs && ')).toBe(true);
    expect(build.indexOf('require-engines-node.mjs')).toBeLessThan(build.indexOf('vite build'));
  });
});
