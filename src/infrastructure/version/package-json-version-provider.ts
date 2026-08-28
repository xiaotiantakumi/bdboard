import { readFileSync } from 'node:fs';
import type { ApplicationVersionProvider } from '../../application/ports/application-version.js';

const PACKAGE_JSON_URL = new URL('../../../package.json', import.meta.url);

function parsePackageVersion(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('bdboard package.json must be an object');
  }

  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('bdboard package.json must contain a non-empty version');
  }

  return version;
}

/**
 * root package.json を起動時に一度だけ読み、以後はそのスナップショットを返す。
 * import.meta.url 基準なので、起動時の cwd に依存しない。
 */
export function createPackageJsonVersionProvider(): ApplicationVersionProvider {
  const version = parsePackageVersion(readFileSync(PACKAGE_JSON_URL, 'utf8'));

  return {
    getVersion: () => version,
  };
}
