// bdboard-72oy: verify の外で走る単発の vitest が、landed の走行中に警告して監査ログに残す globalSetup
// (scripts/vitest-global-setup.mjs -> scripts/vitest-outside-verify.mjs) のテスト。
//
// holder は本物の生きた pid (このテストプロセス) の holder file を一時ディレクトリに置く。guard 自身の holder の
// 名前は selfPid: 0 にして別のファイルにする。env は process.env を使わず毎回渡す (このテストが
// `npm run verify` の中で走ると BDBOARD_IN_VERIFY=1 が立っているため)。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { IN_VERIFY_ENV, SLOT_IDENTITY_ENV, withoutSlotIdentity } from './verify-slot.mjs';
import { checkOutsideVerify, isInsideVerify, landedHolders, LANDED_STATES, OUTSIDE_VERIFY_AUDIT_EVENT } from './vitest-outside-verify.mjs';

const STALE_AGE_MS = 31 * 60_000; // staleTtlMs (30 分) を超えた年齢
const tempDirs = [];
const originalEnv = { ...process.env };
const makeDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-outside-verify-'));
  tempDirs.push(dir);
  return dir;
};

// state: running (acquiredAt あり) / waiting (acquiredAt なし) / reserved (merge-pr の予約。acquiredAt なし + reserved)。
// ageMs = joinedAt (running は acquiredAt も) が何 ms 前か。queuedAgeMs = queuedAt (最初に並んだ時刻) が何 ms 前か
// (既定は ageMs と同じ。並び直した長い待ち手は joinedAt だけが新しい)。
const writeHolder = (dir, { pid = process.pid, priority = 'landed', state = 'running', ageMs = 65_000, queuedAgeMs = ageMs } = {}) => {
  const now = Date.now();
  const at = now - ageMs;
  const holder = { v: 2, pid, joinedAt: at, queuedAt: now - queuedAgeMs, priority };
  if (state === 'running') {
    holder.acquiredAt = at;
  }
  if (state === 'reserved') {
    holder.reserved = true;
  }
  fs.writeFileSync(path.join(dir, `holder-${pid}.json`), JSON.stringify(holder));
  return pid;
};
const envFor = (dir, extra = {}) => ({ BDBOARD_VERIFY_SLOT_DIR: dir, ...extra });
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

// 警告と記録を配列に集めて checkOutsideVerify を呼ぶ。
const runCheck = async (dir, { env = {}, ...rest } = {}) => {
  const warnings = [];
  const records = [];
  const result = await checkOutsideVerify({
    env: envFor(dir, env),
    selfPid: 0,
    warn: (line) => warnings.push(line),
    record: async (fields) => records.push(fields),
    ...rest,
  });
  return { result, warnings, records };
};

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('vitest outside verify: a running landed verify', () => {
  it('warns once and records landed_state=running', async () => {
    const dir = makeDir();
    const pid = writeHolder(dir);
    const { result, warnings, records } = await runCheck(dir);
    expect(result).toMatchObject({ inside: false, state: 'running', warned: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('landed verify');
    expect(warnings[0]).toContain(`pid ${pid}`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ landed_state: 'running', landed_pid: pid, landed_count: 1, project: undefined });
    expect(records[0].landed_running_s).toBeGreaterThanOrEqual(65);
  });

  it('is silent inside verify and does not read the slot directory', async () => {
    const dir = makeDir();
    writeHolder(dir);
    let reads = 0;
    const io = {
      readdirSync() {
        reads += 1;
        throw new Error('must not read');
      },
    };
    const { result, warnings, records } = await runCheck(dir, { env: { [IN_VERIFY_ENV]: '1' }, io });
    expect(result).toEqual({ inside: true, landed: [], state: null, warned: false });
    expect(reads).toBe(0);
    expect(warnings).toEqual([]);
    expect(records).toEqual([]);
  });

  it('is silent and records nothing with no holders, or when the directory does not exist', async () => {
    for (const dir of [makeDir(), path.join(os.tmpdir(), `missing-${process.pid}-${Date.now()}`)]) {
      const { result, warnings, records } = await runCheck(dir);
      expect(result).toMatchObject({ state: null, warned: false });
      expect(warnings).toEqual([]);
      expect(records).toEqual([]);
    }
  });

  // pr と merge は「走っている」holder (生きた pid + acquiredAt) を置く。landed 以外は数えない。
  it.each([
    ['running pr holder', { priority: 'pr' }],
    ['running merge holder', { priority: 'merge' }],
    ['stale running landed holder', { ageMs: STALE_AGE_MS }],
    ['stale waiting landed holder', { state: 'waiting', ageMs: STALE_AGE_MS }],
    ['stale reserved landed holder', { state: 'reserved', ageMs: STALE_AGE_MS }],
  ])('is silent and records nothing for a %s', async (_label, options) => {
    const dir = makeDir();
    writeHolder(dir, options);
    const { result, warnings, records } = await runCheck(dir);
    expect(result).toMatchObject({ state: null, warned: false });
    expect(warnings).toEqual([]);
    expect(records).toEqual([]);
  });

  it('is silent and records nothing for a landed holder whose pid is dead', async () => {
    const dir = makeDir();
    writeHolder(dir, { pid: deadPid() });
    const { result, warnings, records } = await runCheck(dir);
    expect(result.state).toBeNull();
    expect(warnings).toEqual([]);
    expect(records).toEqual([]);
  });

  it('is silent and records nothing when slot gating is disabled (BDBOARD_VERIFY_SLOTS=0), even with a live landed holder', async () => {
    const dir = makeDir();
    writeHolder(dir);
    const { result, warnings, records } = await runCheck(dir, { env: { BDBOARD_VERIFY_SLOTS: '0' } });
    expect(result.state).toBeNull();
    expect(warnings).toEqual([]);
    expect(records).toEqual([]);
  });
});

describe('vitest outside verify: a landed verify that has not started yet (bdboard-72oy F4)', () => {
  it.each([
    ['waiting', { state: 'waiting' }],
    ['reserved', { state: 'reserved' }],
  ])('records landed_state=%s without a warning', async (state, options) => {
    const dir = makeDir();
    const pid = writeHolder(dir, options);
    const { result, warnings, records } = await runCheck(dir);
    expect(result).toMatchObject({ inside: false, state, warned: false });
    expect(warnings).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ landed_state: state, landed_pid: pid, landed_count: 1 });
    expect(records[0].landed_waited_s).toBeGreaterThanOrEqual(65);
    expect(records[0]).not.toHaveProperty('landed_running_s');
  });

  // landed 以外 (pr / merge) は、順番待ちでも予約でも数えない (plan.queue を landed に絞る)。
  it.each([
    ['waiting pr', { priority: 'pr', state: 'waiting' }],
    ['waiting merge', { priority: 'merge', state: 'waiting' }],
    ['reserved pr', { priority: 'pr', state: 'reserved' }],
  ])('records nothing for a %s holder', async (_label, options) => {
    const dir = makeDir();
    writeHolder(dir, options);
    const { result, warnings, records } = await runCheck(dir);
    expect(result).toMatchObject({ state: null, warned: false });
    expect(warnings).toEqual([]);
    expect(records).toEqual([]);
  });

  // 長く待っている新形式の待ち手は stale と見なされる前に joinedAt だけを今にして並び直す (verify-slot.mjs)。
  // 待ちの長さは最初に並んだ queuedAt から数え、joinedAt が新しくても stale にはならない。
  it('records a long waiter that re-joined (old queuedAt, fresh joinedAt) and measures the wait from queuedAt', async () => {
    const dir = makeDir();
    const pid = writeHolder(dir, { state: 'waiting', ageMs: 60_000, queuedAgeMs: 40 * 60_000 });
    const { result, warnings, records } = await runCheck(dir);
    expect(result).toMatchObject({ state: 'waiting', warned: false });
    expect(warnings).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ landed_state: 'waiting', landed_pid: pid });
    expect(records[0].landed_waited_s).toBeGreaterThanOrEqual(40 * 60);
  });

  it('records the heaviest state when several landed holders exist (running over waiting over reserved)', async () => {
    const dir = makeDir();
    const reserved = writeHolder(dir, { pid: process.ppid, state: 'reserved' });
    expect(landedHolders(envFor(dir), { selfPid: 0 })).toMatchObject({ running: [], waiting: [], reserved: [{ pid: reserved }] });

    // 予約に順番待ちを足すと waiting が勝つ。landed_count は記録した状態の holder だけを数える (予約は含めない)。
    const waiting = writeHolder(dir, { state: 'waiting' });
    const waitingOverReserved = await runCheck(dir);
    expect(waitingOverReserved.result).toMatchObject({ state: 'waiting', warned: false });
    expect(waitingOverReserved.records).toHaveLength(1);
    expect(waitingOverReserved.records[0]).toMatchObject({ landed_state: 'waiting', landed_pid: waiting, landed_count: 1 });

    // さらに running を足すと running が勝つ (警告も出る)。3 つ目の生きた pid は別プロセスで用意する。
    const holderProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      const running = writeHolder(dir, { pid: holderProcess.pid, state: 'running' });
      const runningOverAll = await runCheck(dir);
      expect(runningOverAll.result).toMatchObject({ state: 'running', warned: true });
      expect(runningOverAll.warnings).toHaveLength(1);
      expect(runningOverAll.records).toHaveLength(1);
      expect(runningOverAll.records[0]).toMatchObject({ landed_state: 'running', landed_pid: running, landed_count: 1 });
    } finally {
      holderProcess.kill('SIGKILL');
    }
    expect(LANDED_STATES).toEqual(['running', 'waiting', 'reserved']);
  });
});

describe('vitest outside verify: fail open', () => {
  it('does not throw or record for ENOTDIR and EACCES on the slot directory', async () => {
    const parent = makeDir();
    const file = path.join(parent, 'regular-file');
    fs.writeFileSync(file, 'file');
    const enotdir = await runCheck(file);
    expect(enotdir.result.warned).toBe(false);
    expect(enotdir.records).toEqual([]);
    const io = {
      readdirSync() {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };
    const eacces = await runCheck(parent, { io });
    expect(eacces.result.warned).toBe(false);
    expect(eacces.records).toEqual([]);
  });

  it('still records when warn throws, and still warns when record rejects', async () => {
    const dir = makeDir();
    writeHolder(dir);
    const records = [];
    const warnFails = await checkOutsideVerify({
      env: envFor(dir),
      selfPid: 0,
      warn() {
        throw new Error('warn');
      },
      record: async (fields) => records.push(fields),
    });
    expect(warnFails.warned).toBe(true);
    expect(records).toHaveLength(1);
    const warnings = [];
    const recordFails = await checkOutsideVerify({
      env: envFor(dir),
      selfPid: 0,
      warn: (line) => warnings.push(line),
      record: async () => {
        throw new Error('record');
      },
    });
    expect(recordFails.warned).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});

describe('vitest-global-setup', () => {
  // process.env は afterEach が元に戻す。stderr は finally で戻す。
  const withCapturedStderr = async (body) => {
    const originalWrite = process.stderr.write;
    const chunks = [];
    process.stderr.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await body();
    } finally {
      process.stderr.write = originalWrite;
    }
    return chunks.join('');
  };

  it('writes the warning and the audit line outside verify, and never rejects', async () => {
    const { default: setup } = await import(new URL('./vitest-global-setup.mjs', import.meta.url).href);
    const dir = makeDir();
    // 自分の pid の holder は readOthers が自分のものとして飛ばすので、別の生きたプロセスを holder にする。
    const holderProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = writeHolder(dir, { pid: holderProcess.pid });
    const audit = path.join(makeDir(), 'audit.log');
    try {
      process.env.BDBOARD_VERIFY_SLOT_DIR = dir;
      process.env.BDBOARD_VERIFY_SLOTS = '2'; // BDBOARD_VERIFY_SLOTS=0 の緊急脱出ハッチで verify を回しても落ちないように
      process.env.BDBOARD_MERGE_AUDIT_LOG = audit;
      delete process.env[IN_VERIFY_ENV];
      const stderr = await withCapturedStderr(async () => {
        await expect(setup({ config: { root: '/test/project' } })).resolves.toBeUndefined();
      });
      expect(stderr).toContain('vitest: warning:');
      const log = fs.readFileSync(audit, 'utf8');
      expect(log).toContain(`${OUTSIDE_VERIFY_AUDIT_EVENT}\t`);
      expect(log).toContain(`landed_pid=${pid}`);
      expect(log).toContain('landed_state=running');
      expect(log).toContain('project=/test/project');

      // 置き場が壊れていても (通常のファイル) 投げない。
      const file = path.join(makeDir(), 'not-a-directory');
      fs.writeFileSync(file, 'file');
      process.env.BDBOARD_VERIFY_SLOT_DIR = file;
      await expect(setup()).resolves.toBeUndefined();
    } finally {
      holderProcess.kill('SIGKILL');
    }
  });

  it('inside verify it neither warns nor writes the audit log', async () => {
    const { default: setup } = await import(new URL('./vitest-global-setup.mjs', import.meta.url).href);
    const dir = makeDir();
    const holderProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    writeHolder(dir, { pid: holderProcess.pid });
    const audit = path.join(makeDir(), 'audit.log');
    try {
      process.env.BDBOARD_VERIFY_SLOT_DIR = dir;
      process.env.BDBOARD_VERIFY_SLOTS = '2';
      process.env.BDBOARD_MERGE_AUDIT_LOG = audit;
      process.env[IN_VERIFY_ENV] = '1';
      // verify の中では project.config にも触れずに戻る。setup の早期 return の BDBOARD_IN_VERIFY が
      // IN_VERIFY_ENV と食い違うと、中の checkOutsideVerify は黙っていても project.config を読むのでここで落ちる。
      let touched = false;
      const project = {
        get config() {
          touched = true;
          return { root: '/test/project' };
        },
      };
      const stderr = await withCapturedStderr(async () => {
        await expect(setup(project)).resolves.toBeUndefined();
      });
      expect(touched).toBe(false);
      expect(stderr).toBe('');
      expect(fs.existsSync(audit)).toBe(false);
    } finally {
      holderProcess.kill('SIGKILL');
    }
  });
});

describe('the inside-verify flag', () => {
  it('is exactly BDBOARD_IN_VERIFY, is outside the slot identity, and survives withoutSlotIdentity', () => {
    expect(IN_VERIFY_ENV).toBe('BDBOARD_IN_VERIFY');
    expect(SLOT_IDENTITY_ENV).not.toContain(IN_VERIFY_ENV);
    expect(withoutSlotIdentity({ [IN_VERIFY_ENV]: '1', BDBOARD_VERIFY_PRIORITY: 'landed' })).toEqual({ [IN_VERIFY_ENV]: '1' });
  });

  it('counts as inside verify only for the value 1', () => {
    expect(isInsideVerify({ [IN_VERIFY_ENV]: '1' })).toBe(true);
    for (const value of ['0', '', 'true', 'yes', undefined]) {
      expect(isInsideVerify({ [IN_VERIFY_ENV]: value })).toBe(false);
    }
    expect(isInsideVerify({})).toBe(false);
  });

  it('is registered as a globalSetup by both vitest configs', () => {
    const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['../vitest.config.ts', '../web/vitest.config.ts']) {
      const source = fs.readFileSync(path.resolve(scriptsDir, file), 'utf8');
      expect(source).toContain('globalSetup');
      expect(source).toContain('vitest-global-setup.mjs');
    }
  });
});
