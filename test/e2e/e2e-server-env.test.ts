import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVirtualTimers } from '../../src/application/issue-report/external-issue-poll-test-support.js';
import { BdError } from '../../src/application/ports/issue-repository.js';
import { createFakeGhAndBd, createTempMaintainerRoot } from '../../src/bootstrap/external-issues-wiring-test-support.js';
import { wireExternalIssues } from '../../src/bootstrap/wire-external-issues.js';
import { wireIssueDraftService } from '../../src/bootstrap/wire-issue-draft-service.js';
import { wireSelfErrorReporter } from '../../src/bootstrap/wire-self-error-reporter.js';
import { buildE2eServerEnv, type E2eServerEnvInputs } from './e2e-server-env.js';

/**
 * bdboard-em45: e2e のサーバー (global-setup.ts が起動する src/main.ts) は、メンテナ環境 (.beads のある checkout) から
 * 回しても、届いた issue の確認で本物の gh を起動しない。e2e を回さずに、global-setup が渡す env (buildE2eServerEnv) を
 * 本物の配線 (wireExternalIssues) へ通して確かめる。
 *
 * bdboard-xpkz: 同じく、不具合報告の下書き (本体エラー・リフレッシュ失敗など) を、その checkout の data/issue-drafts
 * (= メンテナの本物の下書きの置き場) ではなく、使い捨てのディレクトリに書く。本物の配線 (wireIssueDraftService と
 * wireSelfErrorReporter) に env を通し、実際に下書きを書かせて、書かれた場所をファイルシステムで確かめる。
 */

const HOUR = 60 * 60_000;

function inputs(baseEnv: NodeJS.ProcessEnv = {}, overrides: Partial<E2eServerEnvInputs> = {}): E2eServerEnvInputs {
  const tmp = path.join(path.sep, 'tmp', 'example-e2e');
  return {
    baseEnv,
    port: '8799',
    host: '127.0.0.1',
    dbPath: path.join(tmp, 'cache.db'),
    scanRoots: [path.join(tmp, 'project-a'), path.join(tmp, 'project-b')],
    scanRootsConfigPath: path.join(tmp, 'scan-roots-config.json'),
    issueDraftsDir: path.join(tmp, 'issue-drafts'),
    binDir: path.join(tmp, 'bin'),
    claudeStub: path.join(tmp, 'bin', 'claude'),
    listFixture: path.join(tmp, 'list.json'),
    gateListFixture: path.join(tmp, 'gate.json'),
    leaseFixture: path.join(tmp, 'lease.json'),
    mergeSlotFixture: path.join(tmp, 'merge-slot.json'),
    webDist: path.join(tmp, 'web-dist'),
    instanceNonce: 'example-nonce',
    ...overrides,
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

  describe('the issue drafts (bdboard-xpkz)', () => {
    let root = '';
    let removeRoot: () => Promise<void> = () => Promise.resolve();
    let throwaway = '';

    beforeEach(async () => {
      // 本物のメンテナ checkout と同じく .git のある一時ディレクトリ。下書きの置き場の既定は <root>/data/issue-drafts になる。
      ({ root, remove: removeRoot } = await createTempMaintainerRoot());
      throwaway = await fs.mkdtemp(path.join(os.tmpdir(), 'example-e2e-drafts-'));
    });

    afterEach(async () => {
      await removeRoot();
      await fs.rm(throwaway, { recursive: true, force: true });
    });

    /**
     * 本体エラーの下書きの書き手 2 つを、本物の配線で動かす: API の 5xx / 処理されなかった例外 (report) と、リフレッシュ失敗
     * (observeRefresh。種類が不明の失敗は 3 回続けて下書きになる)。reporter が作られること (止められていないこと) も確かめる:
     * 漏れを塞ぐ手は置き場の向け直しで、本体エラーの下書きを止める (BDBOARD_SELF_ERROR_DRAFTS=off) ことではない。
     */
    async function writeSelfErrorDrafts(env: NodeJS.ProcessEnv): Promise<void> {
      const applicationVersion = { getVersion: () => '1.0.0' };
      const service = wireIssueDraftService({ repoRoot: root, env, applicationVersion, log: vi.fn() });
      const project = { id: 'p', name: 'example-project', rootPath: '/example/project', aliasPaths: [], prefixes: [] };
      const cache = { listProjects: () => [], listProjectRefs: () => [project] };
      const wired = wireSelfErrorReporter({ env, service, cache, applicationVersion, log: vi.fn() });
      expect(wired.reporter).toBeDefined();
      await wired.reporter?.report({ source: 'api:GET /x', errorText: 'boom' });
      const failure = { refreshed: [], reused: [], removed: [], errors: [new BdError('unknown', 'p', 'example failure')] };
      for (let attempt = 0; attempt < 3; attempt += 1) await wired.reporter?.observeRefresh(failure, [project]);
    }

    const exists = (target: string): Promise<boolean> =>
      fs.access(target).then(
        () => true,
        () => false,
      );

    it('control: with an ordinary env the same checkout writes both drafts under <repoRoot>/data/issue-drafts (so the assertions below are not vacuous)', async () => {
      await writeSelfErrorDrafts({});

      expect(await fs.readdir(path.join(root, 'data', 'issue-drafts'))).toHaveLength(2);
    });

    it('writes the self-error drafts to the throwaway directory and creates nothing under <repoRoot>/data', async () => {
      const issueDraftsDir = path.join(throwaway, 'issue-drafts');

      await writeSelfErrorDrafts(buildE2eServerEnv(inputs({}, { issueDraftsDir })));

      expect(await fs.readdir(issueDraftsDir)).toHaveLength(2);
      expect(await exists(path.join(root, 'data'))).toBe(false);
    });

    it.each([
      ['the real place', () => path.join(root, 'data', 'issue-drafts')],
      ['an empty string', () => ''],
    ])('overrides BDBOARD_ISSUE_DRAFTS_DIR inherited from the parent environment (%s)', async (_label, inherited) => {
      const issueDraftsDir = path.join(throwaway, 'issue-drafts');

      await writeSelfErrorDrafts(buildE2eServerEnv(inputs({ BDBOARD_ISSUE_DRAFTS_DIR: inherited() }, { issueDraftsDir })));

      expect(await fs.readdir(issueDraftsDir)).toHaveLength(2);
      expect(await exists(path.join(root, 'data'))).toBe(false);
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

    it('puts the issue drafts directory inside its throwaway tmpRoot, which teardown removes', () => {
      expect(source).toMatch(/\bissueDraftsDir: path\.join\(tmpRoot, 'issue-drafts'\)/);
      expect(source).not.toContain('BDBOARD_ISSUE_DRAFTS_DIR');
    });
  });
});
