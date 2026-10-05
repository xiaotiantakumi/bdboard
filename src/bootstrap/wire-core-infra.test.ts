/**
 * bdboard-424g: 起動時に 1 回だけ読む bd の版 (readBdVersion) の結果を、起動時の診断 (runBdVersionStartupCheck) と
 * 下書きの envInfo (infra.bdVersion) が共有する。`bd version` を追加で起動しないことを、偽の bd の呼び出し回数で固定する。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireCoreInfra } from './wire-core-infra.js';

function makeLog() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('wireCoreInfra bdVersion', () => {
  let root = '';
  let cache: { close(): void } | undefined;
  afterEach(async () => {
    cache?.close();
    cache = undefined;
    if (root !== '') await fs.rm(root, { recursive: true, force: true });
    root = '';
  });

  it('shares one startup read between the startup check and the snapshot', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-core-infra-'));
    const calls = path.join(root, 'calls');
    const fakeBd = path.join(root, 'bd');
    // 呼ばれるたびに 1 行足し、少し待ってから版を出す (読み終わる前の 'unknown' を確かめる時間を作る)。
    await fs.writeFile(fakeBd, `#!/bin/sh\nprintf 'call\\n' >> '${calls}'\nsleep 0.2\nprintf '%s\\n' '{"version":"9.9.9"}'\n`);
    await fs.chmod(fakeBd, 0o755);
    const log = makeLog();

    const infra = wireCoreInfra({
      dbPath: path.join(root, 'board.sqlite'),
      configFilePath: path.join(root, 'config.json'),
      bdPath: fakeBd,
      bdVersionCheckTimeoutMs: 3000,
      log,
    });
    cache = infra.cache;

    // wireCoreInfra は読み取りを待たずに返り、読み終わるまでは 'unknown'。
    expect(infra.bdVersion()).toBe('unknown');
    await vi.waitFor(() => expect(infra.bdVersion()).toBe('9.9.9'));
    // 起動時の診断も同じ読み取りの結果で動く (EXPECTED_BD_VERSION と違う 9.9.9 なので mismatch の警告が出る)。
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('found 9.9.9')));
    expect((await fs.readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('keeps unknown when bd cannot be started', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-core-infra-missing-'));
    const log = makeLog();

    const infra = wireCoreInfra({
      dbPath: path.join(root, 'board.sqlite'),
      configFilePath: path.join(root, 'config.json'),
      bdPath: path.join(root, 'missing-bd'),
      bdVersionCheckTimeoutMs: 3000,
      log,
    });
    cache = infra.cache;

    // 起動時の診断が終わった (= 読み取りが失敗で終わった) あとも 'unknown'。
    await vi.waitFor(() => expect(log.log).toHaveBeenCalled());
    expect(infra.bdVersion()).toBe('unknown');
  });
});
