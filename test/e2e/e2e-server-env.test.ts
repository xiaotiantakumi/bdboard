
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildE2eServerEnv, type E2eServerEnvInputs } from './e2e-server-env.js';

/** e2e のサーバー (global-setup.ts が起動する src/main.ts) に渡す env (buildE2eServerEnv) の性質を、e2e を回さずに固定する。 */

function inputs(baseEnv: NodeJS.ProcessEnv = {}, overrides: Partial<E2eServerEnvInputs> = {}): E2eServerEnvInputs {
  const tmp = path.join(path.sep, 'tmp', 'example-e2e');
  return {
    baseEnv,
    port: '8799',
    host: '127.0.0.1',
    dbPath: path.join(tmp, 'cache.db'),
    scanRoots: [path.join(tmp, 'project-a'), path.join(tmp, 'project-b')],
    scanRootsConfigPath: path.join(tmp, 'scan-roots-config.json'),
    binDir: path.join(tmp, 'bin'),
    claudeStub: path.join(tmp, 'bin', 'claude'),
    listFixture: path.join(tmp, 'list.json'),
    webDist: path.join(tmp, 'web-dist'),
    instanceNonce: 'example-nonce',
    ...overrides,
  };
}

describe('buildE2eServerEnv', () => {
  describe('the rest of the env', () => {
    it('puts the stub directory first on PATH and keeps the parent PATH after it', () => {
      const env = buildE2eServerEnv(inputs({ PATH: '/usr/bin' }));
      expect(env.PATH).toBe(`${path.join(path.sep, 'tmp', 'example-e2e', 'bin')}${path.delimiter}/usr/bin`);
    });

    it('does not pin the always-on port and passes the resolved e2e port through', () => {
      const env = buildE2eServerEnv(inputs({ BDBOARD_PORT: '8787' }));
      expect(env.BDBOARD_PORT).toBe('8799');
    });

    it('joins the scan roots with commas and disables auth, the AI quota widget and the reclaim loop', () => {
      const env = buildE2eServerEnv(inputs());
      const tmp = path.join(path.sep, 'tmp', 'example-e2e');
      expect(env.BDBOARD_SCAN_ROOTS).toBe(`${path.join(tmp, 'project-a')},${path.join(tmp, 'project-b')}`);
      expect(env.BDBOARD_AUTH_DISABLED).toBe('1');
      expect(env.BDBOARD_AI_QUOTA_DISABLED).toBe('1');
      expect(env.BDBOARD_RECLAIM_ENABLED).toBe('0');
    });

    it('keeps unrelated parent variables', () => {
      const env = buildE2eServerEnv(inputs({ HOME: '/home/example' }));
      expect(env.HOME).toBe('/home/example');
    });
  });

  describe('global-setup.ts', () => {
    // 上の検査は buildE2eServerEnv の性質しか見ない。global-setup がその結果を spawn にそのまま渡していること
    // (後ろで別の値を足したり、親の env を重ねたりしないこと) は、ここでソースを読んで固定する。global-setup は
    // web/dist の写しやサーバーの起動まで行うので、vitest からは呼べない。
    const source = readFileSync(fileURLToPath(new URL('./global-setup.ts', import.meta.url)), 'utf8');

    it('passes the result of buildE2eServerEnv to spawn as the whole env', () => {
      expect(source.match(/buildE2eServerEnv\(/g)).toHaveLength(1);
      expect(source).toMatch(/\benv: buildE2eServerEnv\(\{/);
    });
  });
});
