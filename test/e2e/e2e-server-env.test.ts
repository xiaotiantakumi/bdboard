import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVirtualTimers } from '../../src/application/issue-report/external-issue-poll-test-support.js';
import { createFakeGhAndBd, createTempMaintainerRoot } from '../../src/bootstrap/external-issues-wiring-test-support.js';
import { wireExternalIssues } from '../../src/bootstrap/wire-external-issues.js';
import { buildE2eServerEnv, type E2eServerEnvInputs } from './e2e-server-env.js';

/**
 * bdboard-em45: e2e のサーバー (global-setup.ts が起動する src/main.ts) は、メンテナ環境 (.beads のある checkout) から
 * 回しても、届いた issue の確認で本物の gh を起動しない。e2e を回さずに、global-setup が渡す env (buildE2eServerEnv) を
 * 本物の配線 (wireExternalIssues) へ通して確かめる。
 */

const HOUR = 60 * 60_000;

function inputs(baseEnv: NodeJS.ProcessEnv = {}): E2eServerEnvInputs {
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
    gateListFixture: path.join(tmp, 'gate.json'),
    leaseFixture: path.join(tmp, 'lease.json'),
    mergeSlotFixture: path.join(tmp, 'merge-slot.json'),
    webDist: path.join(tmp, 'web-dist'),
    instanceNonce: 'example-nonce',
  };
}

describe('buildE2eServerEnv', () => {
  describe('the incoming-issue check', () => {
    let root = '';
    let removeRoot: () => Promise<void> = () => Promise.resolve();
    const wired: Array<{ stop: () => void }> = [];

    beforeEach(async () => {
      // 本物のメンテナ checkout と同じく .beads がある一時ディレクトリ (e2e を main checkout から回した状態)。
      ({ root, remove: removeRoot } = await createTempMaintainerRoot());
    });

    afterEach(async () => {
      for (const each of wired.splice(0)) each.stop();
      vi.resetAllMocks();
      vi.restoreAllMocks();
      await removeRoot();
    });

    function wire(env: NodeJS.ProcessEnv) {
      const timers = createVirtualTimers();
      const fake = createFakeGhAndBd();
      const result = wireExternalIssues({
        repoRoot: root,
        env,
        commandRunner: fake.runner,
        log: vi.fn(),
        monotonicNow: timers.now,
        timers,
      });
      wired.push(result);
      return { result, timers, fake };
    }

    it('control: the same checkout with an ordinary env does start the check (so the assertions below are not vacuous)', async () => {
      const { result, timers, fake } = wire({});

      expect(result.enabled).toBe(true);
      await timers.advanceTo(2 * HOUR);
      expect(fake.ghCalls().length).toBeGreaterThan(0);
    });

    it('keeps the e2e server from creating a timer or launching gh or bd, even in a checkout that has .beads', async () => {
      const { result, timers, fake } = wire(buildE2eServerEnv(inputs()));

      expect(result.enabled).toBe(false);
      expect(result.service).toBeUndefined();
      expect(timers.created).toHaveLength(0);
      await timers.advanceTo(2 * HOUR);
      expect(fake.run).not.toHaveBeenCalled();
    });

    it.each(['0', 'false', ''])('overrides %j inherited from the parent environment', (inherited) => {
      const { result, timers, fake } = wire(
        buildE2eServerEnv(inputs({ BDBOARD_EXTERNAL_ISSUES_DISABLED: inherited, BDBOARD_EXTERNAL_ISSUES_INTERVAL_MS: '300000' })),
      );

      expect(result.enabled).toBe(false);
      expect(timers.created).toHaveLength(0);
      expect(fake.run).not.toHaveBeenCalled();
    });
  });

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

    it('does not set the incoming-issue switch on its own', () => {
      expect(source).not.toContain('BDBOARD_EXTERNAL_ISSUES_DISABLED');
    });
  });
});
