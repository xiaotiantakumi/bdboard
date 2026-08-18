// bdboard-d48: verify 実行スロット (verify-slot.mjs) のテスト。
//
// 目玉は「6プロセス同時投入しても同時実行が2を超えない」の実プロセステストで、
// acceptance criteria の実機確認を CI でも回る形に常設化したもの。個々のテストは
// mkdtemp した専用ディレクトリを使うので、実運用のスロット (os.tmpdir() 配下の
// 既定ディレクトリ) や並行する他セッションの verify とは干渉しない。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { acquireVerifySlot, envSlotOptions, SlotWaitTimeoutError } from './verify-slot.mjs';

const modulePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-slot.mjs');

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'verify-slot-test-'));

const fastOptions = (dir, overrides = {}) => ({
  dir,
  slots: 1,
  waitTimeoutMs: 3_000,
  staleTtlMs: 60_000,
  pollMs: 25,
  settleMs: 10,
  statusIntervalMs: 60_000,
  ...overrides,
});

const noLog = () => {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const holderFile = (dir, pid) => path.join(dir, `holder-${pid}.json`);

const writeFakeHolder = (dir, pid, joinedAt) => {
  fs.writeFileSync(holderFile(dir, pid), JSON.stringify({ pid, joinedAt, cwd: '/fake' }));
};

// 生きた別プロセス (30秒の setTimeout を抱えた node)。テスト末尾で必ず kill する。
const spawnLiveProcess = () =>
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });

// 既に死んでいる pid が欲しいとき: 即終了する node を同期実行して、その pid を使う。
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

describe('acquireVerifySlot', () => {
  it('acquires immediately when a slot is free and removes the holder file on release', async () => {
    const dir = makeDir();
    const slot = await acquireVerifySlot(fastOptions(dir), noLog);
    expect(fs.existsSync(holderFile(dir, process.pid))).toBe(true);
    slot.release();
    expect(fs.existsSync(holderFile(dir, process.pid))).toBe(false);
    slot.release(); // 冪等
  });

  it('waits while another live process holds the only slot, then proceeds when it is released', async () => {
    const dir = makeDir();
    const other = spawnLiveProcess();
    try {
      writeFakeHolder(dir, other.pid, Date.now() - 1_000);
      const pending = acquireVerifySlot(fastOptions(dir), noLog);
      let settled = false;
      pending.then(() => {
        settled = true;
      });
      await sleep(200);
      expect(settled).toBe(false); // 先客が生きている間は待つ
      fs.unlinkSync(holderFile(dir, other.pid)); // 先客が release した相当
      const slot = await pending;
      slot.release();
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('times out with SlotWaitTimeoutError and cleans up its own holder file', async () => {
    const dir = makeDir();
    const other = spawnLiveProcess();
    try {
      writeFakeHolder(dir, other.pid, Date.now() - 1_000);
      await expect(
        acquireVerifySlot(fastOptions(dir, { waitTimeoutMs: 300 }), noLog),
      ).rejects.toBeInstanceOf(SlotWaitTimeoutError);
      expect(fs.existsSync(holderFile(dir, process.pid))).toBe(false); // 自分の分は片付ける
      expect(fs.existsSync(holderFile(dir, other.pid))).toBe(true); // 先客の分は消さない
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('reclaims holder files whose pid is dead', async () => {
    const dir = makeDir();
    const stalePid = deadPid();
    writeFakeHolder(dir, stalePid, Date.now() - 1_000);
    const slot = await acquireVerifySlot(fastOptions(dir), noLog);
    expect(fs.existsSync(holderFile(dir, stalePid))).toBe(false); // 死骸は回収される
    slot.release();
  });

  it('stops counting a live holder older than staleTtlMs but does not delete its file', async () => {
    const dir = makeDir();
    const other = spawnLiveProcess();
    try {
      writeFakeHolder(dir, other.pid, Date.now() - 10_000);
      const slot = await acquireVerifySlot(fastOptions(dir, { staleTtlMs: 5_000 }), noLog);
      expect(fs.existsSync(holderFile(dir, other.pid))).toBe(true); // 生存中なので消さない
      slot.release();
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('replaces a leftover holder file that reuses our own pid', async () => {
    const dir = makeDir();
    fs.writeFileSync(holderFile(dir, process.pid), 'not json (previous life of this pid)');
    const slot = await acquireVerifySlot(fastOptions(dir), noLog);
    const holder = JSON.parse(fs.readFileSync(holderFile(dir, process.pid), 'utf8'));
    expect(holder.pid).toBe(process.pid);
    slot.release();
  });

  it('disables gating when slots <= 0', async () => {
    const dir = makeDir();
    const slot = await acquireVerifySlot(fastOptions(dir, { slots: 0 }), noLog);
    expect(fs.readdirSync(dir)).toEqual([]); // holder file すら作らない
    slot.release();
  });

  it(
    'never lets more than 2 of 6 concurrent submissions run at once, and runs them all',
    { timeout: 30_000 },
    async () => {
      const dir = makeDir();
      const logPath = path.join(dir, 'events.log');
      const childSource = `
        import fs from 'node:fs';
        const { acquireVerifySlot } = await import(process.env.VERIFY_SLOT_MODULE_URL);
        const slot = await acquireVerifySlot(
          {
            dir: process.env.VERIFY_SLOT_DIR,
            slots: 2,
            waitTimeoutMs: 20000,
            staleTtlMs: 60000,
            pollMs: 25,
            settleMs: 50,
            statusIntervalMs: 60000,
          },
          () => {},
        );
        const logEvent = (ev) =>
          fs.appendFileSync(
            process.env.VERIFY_SLOT_LOG,
            JSON.stringify({ t: Date.now(), pid: process.pid, ev }) + '\\n',
          );
        logEvent('start');
        await new Promise((resolve) => setTimeout(resolve, 400));
        logEvent('end');
        slot.release();
      `;
      const children = Array.from({ length: 6 }, () =>
        spawn(process.execPath, ['--input-type=module', '-e', childSource], {
          env: {
            ...process.env,
            VERIFY_SLOT_MODULE_URL: pathToFileURL(modulePath).href,
            VERIFY_SLOT_DIR: dir,
            VERIFY_SLOT_LOG: logPath,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        }),
      );
      const results = await Promise.all(
        children.map(
          (child) =>
            new Promise((resolve) => {
              let stderr = '';
              child.stderr.on('data', (chunk) => {
                stderr += chunk;
              });
              child.on('exit', (code) => resolve({ code, stderr }));
            }),
        ),
      );
      for (const { code, stderr } of results) {
        expect(stderr).toBe('');
        expect(code).toBe(0);
      }

      const events = fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        // 同時刻タイなら end を先に処理 (計測を過大にしない保守的な順序)。
        .sort((a, b) => a.t - b.t || (a.ev === 'end' ? -1 : 1));
      expect(events.filter((event) => event.ev === 'start')).toHaveLength(6);
      expect(events.filter((event) => event.ev === 'end')).toHaveLength(6);
      let running = 0;
      let maxRunning = 0;
      for (const event of events) {
        running += event.ev === 'start' ? 1 : -1;
        maxRunning = Math.max(maxRunning, running);
      }
      expect(maxRunning).toBeLessThanOrEqual(2); // 上限は絶対に超えない
      expect(maxRunning).toBe(2); // かつ 2 本までの並列は許す (完全直列化していない)
      expect(fs.readdirSync(dir).filter((name) => name.startsWith('holder-'))).toEqual([]);
    },
  );
});

describe('envSlotOptions', () => {
  it('returns overrides only for env vars that are set and numeric', () => {
    expect(envSlotOptions({})).toEqual({});
    expect(
      envSlotOptions({
        BDBOARD_VERIFY_SLOTS: '3',
        BDBOARD_VERIFY_SLOT_DIR: '/somewhere',
        BDBOARD_VERIFY_SLOT_WAIT_MS: '1000',
      }),
    ).toEqual({ slots: 3, dir: '/somewhere', waitTimeoutMs: 1_000 });
    expect(envSlotOptions({ BDBOARD_VERIFY_SLOTS: 'garbage', BDBOARD_VERIFY_SLOT_WAIT_MS: '' })).toEqual({});
    expect(envSlotOptions({ BDBOARD_VERIFY_SLOTS: '0' })).toEqual({ slots: 0 });
  });
});
