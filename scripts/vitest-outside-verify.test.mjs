import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { IN_VERIFY_ENV, SLOT_IDENTITY_ENV, withoutSlotIdentity } from './verify-slot.mjs';
import { checkOutsideVerify, isInsideVerify, OUTSIDE_VERIFY_AUDIT_EVENT, runningLandedHolders } from './vitest-outside-verify.mjs';

const tempDirs = [];
const originalEnv = { ...process.env };
const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-outside-verify-'));
  tempDirs.push(dir);
  return dir;
};
const writeHolder = (dir, { pid = process.pid, priority = 'landed', acquiredAt = Date.now() - 65_000 } = {}) => {
  fs.writeFileSync(path.join(dir, `holder-${pid}.json`), JSON.stringify({ v: 2, pid, joinedAt: acquiredAt - 1_000, queuedAt: acquiredAt - 1_000, acquiredAt, priority }));
  return pid;
};
const envFor = (dir, extra = {}) => ({ BDBOARD_VERIFY_SLOT_DIR: dir, ...extra });

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('vitest outside verify warning', () => {
  it('warns and records once for a running landed holder', async () => {
    const dir = makeDir();
    const pid = writeHolder(dir);
    const warnings = [];
    const records = [];
    const result = await checkOutsideVerify({ env: envFor(dir), now: Date.now(), selfPid: 0, warn: (message) => warnings.push(message), record: async (fields) => records.push(fields) });
    expect(result.warned).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('landed verify');
    expect(warnings[0]).toContain(`pid ${pid}`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ landed_pid: pid, landed_count: 1, project: undefined });
  });

  it('is silent inside verify without reading the slot directory', async () => {
    const dir = makeDir();
    writeHolder(dir);
    let reads = 0;
    const warnings = [];
    const records = [];
    const result = await checkOutsideVerify({ env: envFor(dir, { [IN_VERIFY_ENV]: '1' }), selfPid: 0,
      io: { readdirSync() { reads += 1; throw new Error('must not read'); } },
      warn: (line) => warnings.push(line), record: async (fields) => records.push(fields) });
    expect(result).toEqual({ inside: true, landed: [], warned: false });
    expect(reads).toBe(0);
    expect(warnings).toEqual([]);
    expect(records).toEqual([]);
  });

  it('is silent when there are no holders or the directory does not exist', async () => {
    const empty = makeDir();
    for (const dir of [empty, path.join(os.tmpdir(), `missing-${process.pid}-${Date.now()}`)]) {
      const result = await checkOutsideVerify({ env: envFor(dir), selfPid: 0, warn: () => { throw new Error('unexpected'); }, record: async () => { throw new Error('unexpected'); } });
      expect(result.warned).toBe(false);
    }
  });

  it.each([
    ['pr holder', { priority: 'pr' }],
    ['waiting landed holder', { acquiredAt: undefined }],
    ['stale landed holder', { acquiredAt: Date.now() - 31 * 60_000 }],
  ])('is silent for a %s', async (_label, options) => {
    const dir = makeDir();
    const values = { ...options };
    const pid = writeHolder(dir, values);
    if (values.acquiredAt === undefined) {
      const file = path.join(dir, `holder-${pid}.json`);
      fs.writeFileSync(file, JSON.stringify({ v: 2, pid, joinedAt: Date.now() - 1_000, queuedAt: Date.now() - 1_000, priority: 'landed' }));
    }
    const result = await checkOutsideVerify({ env: envFor(dir), selfPid: 0, warn: () => {}, record: async () => {} });
    expect(result.warned).toBe(false);
  });

  it('is silent for a dead pid and when slots are disabled', async () => {
    const dir = makeDir();
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    writeHolder(dir, { pid: deadPid });
    expect((await checkOutsideVerify({ env: envFor(dir), selfPid: 0, warn: () => {}, record: async () => {} })).warned).toBe(false);
    expect((await checkOutsideVerify({ env: envFor(dir, { BDBOARD_VERIFY_SLOTS: '0' }), selfPid: 0, warn: () => {}, record: async () => {} })).warned).toBe(false);
  });

  it('fails open for ENOTDIR, EACCES, and callback failures', async () => {
    const parent = makeDir();
    const file = path.join(parent, 'regular-file');
    fs.writeFileSync(file, 'file');
    expect((await checkOutsideVerify({ env: envFor(file), selfPid: 0 })).warned).toBe(false);
    const eacces = { readdirSync() { const error = new Error('denied'); error.code = 'EACCES'; throw error; } };
    expect((await checkOutsideVerify({ env: envFor(parent), selfPid: 0, io: eacces })).warned).toBe(false);

    writeHolder(parent);
    const records = [];
    const warnFails = await checkOutsideVerify({ env: envFor(parent), selfPid: 0, warn() { throw new Error('warn'); }, record: async (fields) => records.push(fields) });
    expect(warnFails.warned).toBe(true);
    expect(records).toHaveLength(1);
    const warnings = [];
    const recordFails = await checkOutsideVerify({ env: envFor(parent), selfPid: 0, warn: (line) => warnings.push(line), record: async () => { throw new Error('record'); } });
    expect(recordFails.warned).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('the global setup writes the warning and the audit line, and never rejects', async () => {
    const { default: setup } = await import(new URL('./vitest-global-setup.mjs', import.meta.url).href);
    const dir = makeDir();
    // 自分の pid の holder は readOthers が自分のものとして飛ばすので、別の生きたプロセスを holder にする。
    const holderProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = writeHolder(dir, { pid: holderProcess.pid });
    const audit = path.join(makeDir(), 'audit.log');
    const originalWrite = process.stderr.write;
    const warnings = [];
    try {
      // process.env は afterEach が元に戻す。
      process.env.BDBOARD_VERIFY_SLOT_DIR = dir;
      process.env.BDBOARD_MERGE_AUDIT_LOG = audit;
      delete process.env[IN_VERIFY_ENV];
      process.stderr.write = (chunk) => {
        warnings.push(String(chunk));
        return true;
      };
      await expect(setup({ config: { root: '/test/project' } })).resolves.toBeUndefined();
      expect(warnings.join('')).toContain('vitest: warning:');
      const log = fs.readFileSync(audit, 'utf8');
      expect(log).toContain(`${OUTSIDE_VERIFY_AUDIT_EVENT}\t`);
      expect(log).toContain(`landed_pid=${pid}`);
      expect(log).toContain('project=/test/project');

      const file = path.join(makeDir(), 'not-a-directory');
      fs.writeFileSync(file, 'file');
      process.env.BDBOARD_VERIFY_SLOT_DIR = file;
      await expect(setup()).resolves.toBeUndefined();
    } finally {
      holderProcess.kill('SIGKILL');
      process.stderr.write = originalWrite;
    }
  });

  it('keeps the inside flag outside slot identity and wires both vitest configs', () => {
    expect(IN_VERIFY_ENV).toBe('BDBOARD_IN_VERIFY');
    expect(SLOT_IDENTITY_ENV).not.toContain(IN_VERIFY_ENV);
    expect(withoutSlotIdentity({ [IN_VERIFY_ENV]: '1', BDBOARD_VERIFY_PRIORITY: 'landed' })).toEqual({ [IN_VERIFY_ENV]: '1' });
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['../vitest.config.ts', '../web/vitest.config.ts']) {
      const source = fs.readFileSync(path.resolve(scriptsDir, file), 'utf8');
      expect(source).toContain('globalSetup');
      expect(source).toContain('vitest-global-setup.mjs');
    }
  });

  it('identifies verify env and returns only running landed holders', () => {
    const dir = makeDir();
    const pid = writeHolder(dir);
    expect(isInsideVerify({ [IN_VERIFY_ENV]: '1' })).toBe(true);
    expect(runningLandedHolders(envFor(dir, { BDBOARD_VERIFY_SLOTS: '100' }), { selfPid: 0 }).map((holder) => holder.pid)).toEqual([pid]);
  });
});
