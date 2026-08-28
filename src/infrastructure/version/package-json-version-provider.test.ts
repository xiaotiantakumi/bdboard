import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPackageJsonVersionProvider } from './package-json-version-provider.js';

const ROOT_PACKAGE_JSON_URL = new URL('../../../package.json', import.meta.url);

describe('createPackageJsonVersionProvider', () => {
  it('returns the version from the root package.json', () => {
    const rootPackage = JSON.parse(
      readFileSync(ROOT_PACKAGE_JSON_URL, 'utf8'),
    ) as { version: string };

    expect(createPackageJsonVersionProvider().getVersion()).toBe(rootPackage.version);
  });
});
