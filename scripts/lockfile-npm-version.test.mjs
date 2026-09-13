// bdboard-m4sl: コミットする lockfile は Node 22 同梱の npm 10 系が書く形に揃える。
//
// npm 11 系が新しく解決したプラットフォーム別バイナリ (rollup / lzma の linux 版など) の
// エントリには "libc": ["glibc"|"musl"] が書き足される。npm 10 系はこのフィールドを書かないため、
// npm 11 で作った lockfile をコミットすると、npm 10 (CI とメインチェックアウトの Node 22) で
// npm install するたびにそれが消えて作業ツリーが汚れ、無関係な PR に lockfile 差分が紛れ込む。
// CI の npm ci は lockfile を書き換えないのでこのズレを拾えない — ここで拾う。
//
// 落ちたら npm 10 で lockfile を再生成する (Node 24 以降の同梱 npm は 11 系なので、手元の Node に
// 依らない `npx -y npm@10 install --package-lock-only` と `npx -y npm@10 --prefix web install
// --package-lock-only` が確実)。方針の詳細は docs/VERIFY.md の「lockfile と npm の版」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOCKFILES = ['package-lock.json', 'web/package-lock.json'];

describe.each(LOCKFILES)('%s', (relativePath) => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));

  it('is lockfileVersion 3 (npm 7+)', () => {
    expect(lock.lockfileVersion).toBe(3);
  });

  it('has no npm 11-only "libc" fields (regenerate it with the npm 10 bundled with Node 22)', () => {
    // packages が無い lockfile で素通りしないよう、先に形を確かめる。
    expect(lock.packages).toBeTypeOf('object');
    expect(Object.keys(lock.packages).length).toBeGreaterThan(0);
    const withLibc = Object.entries(lock.packages)
      .filter(([, entry]) => entry !== null && typeof entry === 'object' && 'libc' in entry)
      .map(([key]) => key);
    expect(withLibc).toEqual([]);
  });
});
