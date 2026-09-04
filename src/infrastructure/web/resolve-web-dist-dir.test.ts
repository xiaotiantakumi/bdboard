import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWebDistDir } from './resolve-web-dist-dir.js';

describe('resolveWebDistDir', () => {
  const repoRoot = path.resolve(path.sep + 'tmp', 'bdboard-repo');

  it('defaults to <repoRoot>/web/dist when BDBOARD_WEB_DIST is unset', () => {
    expect(resolveWebDistDir(repoRoot, {})).toBe(path.join(repoRoot, 'web', 'dist'));
  });

  it('defaults to <repoRoot>/web/dist when BDBOARD_WEB_DIST is empty', () => {
    expect(resolveWebDistDir(repoRoot, { BDBOARD_WEB_DIST: '' })).toBe(
      path.join(repoRoot, 'web', 'dist'),
    );
  });

  it('uses BDBOARD_WEB_DIST when set', () => {
    const override = path.resolve(path.sep + 'tmp', 'bdboard-e2e-web-dist');
    expect(resolveWebDistDir(repoRoot, { BDBOARD_WEB_DIST: override })).toBe(override);
  });

  it('resolves relative BDBOARD_WEB_DIST against cwd', () => {
    const relative = 'snapshot/web-dist';
    expect(resolveWebDistDir(repoRoot, { BDBOARD_WEB_DIST: relative })).toBe(
      path.resolve(relative),
    );
  });
});
