import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの scripts/bd-heartbeat.sh 統合テスト (bdboard-0kql)。
 *
 * hook テスト (pack-hooks.test.ts) と同型: bash spawn / isolatedEnv / fake bd /
 * mkdtemp / Windows skip。テスト自体が孤児ループを残さないことも検証対象。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const HEARTBEAT_SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'bd-heartbeat.sh');
const PACK_HARNESS_DIR = path.join(PACKS_ROOT, 'bdboard-harness');

const runner = new NodeCommandRunner();

const BASH32_PATH = '/bin/bash';

async function detectBinBashMajorVersion(): Promise<number | undefined> {
  if (!existsSync(BASH32_PATH)) {
    return undefined;
  }
  try {
    const result = await runner.run(BASH32_PATH, ['--version'], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const out = `${result.stdout}\n${result.stderr}`;
    const match = out.match(/(\d+)\.\d+\.\d+/);
    if (!match) {
      return undefined;
    }
    const major = Number.parseInt(match[1] ?? '', 10);
    return Number.isFinite(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

function collectShellScripts(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectShellScripts(fullPath));
      continue;
    }
    if (entry.endsWith('.sh')) {
      files.push(fullPath);
    }
  }
  return files;
}

const SHELL_SCRIPTS = collectShellScripts(PACK_HARNESS_DIR);

interface HeartbeatEnv {
  readonly env: Record<string, string>;
  readonly tmpDir: string;
  readonly binDir: string;
  readonly argsLog: string;
  readonly fixturePath: string;
  readonly counterDir: string;
}

interface SessionProcess {
  readonly pid: number;
  readonly stop: () => Promise<void>;
}

function stateUid(): string {
  return String(process.getuid?.() ?? 'unknown');
}

function stateDir(tmpDir: string): string {
  return path.join(tmpDir, `bd-heartbeat.${stateUid()}`);
}

function pidfilePath(tmpDir: string, sessionPid: number): string {
  return path.join(stateDir(tmpDir), `${sessionPid}.pid`);
}

function logfilePath(tmpDir: string, sessionPid: number): string {
  return path.join(stateDir(tmpDir), `${sessionPid}.log`);
}

function idsfilePath(tmpDir: string, sessionPid: number): string {
  return path.join(stateDir(tmpDir), `${sessionPid}.ids`);
}

describe.skipIf(process.platform === 'win32')('bdboard-harness pack bd-heartbeat.sh', () => {
  let tmpRoot: string;
  let activeSessions: Array<{
    readonly sessionPid: number;
    readonly hbEnv: HeartbeatEnv;
    readonly stopSession: () => Promise<void>;
  }> = [];
  let trackedProcesses: Array<{ readonly pid: number; readonly env: Record<string, string> }> = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-pack-heartbeat-'));
    activeSessions = [];
    trackedProcesses = [];
  });

  afterEach(async () => {
    for (const { sessionPid, hbEnv } of activeSessions) {
      await runHeartbeat(['stop', '--session-pid', String(sessionPid)], hbEnv).catch(() => {
        /* best-effort */
      });
    }
    for (const { pid, env } of trackedProcesses) {
      await killProcessByPid(pid, env);
    }
    activeSessions = [];
    trackedProcesses = [];
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setupEnv(): HeartbeatEnv {
    const envRoot = mkdtempSync(path.join(tmpRoot, 'hb-'));
    const tmpDir = path.join(envRoot, 'state');
    mkdirSync(tmpDir, { recursive: true });

    const binDir = path.join(envRoot, 'bin');
    mkdirSync(binDir, { recursive: true });

    const argsLog = path.join(envRoot, 'bd-args.log');
    const fixturePath = path.join(envRoot, 'bd-fixture.env');
    const counterDir = path.join(envRoot, 'counters');
    mkdirSync(counterDir, { recursive: true });

    writeFileSync(
      path.join(binDir, 'bd'),
      [
        '#!/bin/sh',
        `ARGS_LOG='${argsLog}'`,
        `FIXTURE='${fixturePath}'`,
        `COUNTER_DIR='${counterDir}'`,
        'if [ "${1:-}" = "-C" ]; then shift 2; fi',
        'cmd="${1:-}"',
        'id="${2:-}"',
        'printf \'call cmd=%s id=%s\\n\' "$cmd" "$id" >> "$ARGS_LOG"',
        '',
        'fixture_val() {',
        '  key="$1"',
        '  [ -f "$FIXTURE" ] || return 1',
        '  line=$(grep "^${key}=" "$FIXTURE" 2>/dev/null | head -1 || true)',
        '  [ -n "$line" ] || return 1',
        '  printf "%s" "${line#*=}"',
        '  return 0',
        '}',
        '',
        'show_count() {',
        '  f="$COUNTER_DIR/show-${id}"',
        '  if [ -f "$f" ]; then cat "$f"; else echo 0; fi',
        '}',
        '',
        'inc_show_count() {',
        '  f="$COUNTER_DIR/show-${id}"',
        '  n=$(show_count)',
        '  n=$((n + 1))',
        '  echo "$n" > "$f"',
        '  echo "$n"',
        '}',
        '',
        'case "$cmd" in',
        '  heartbeat)',
        '    case "$(fixture_val "HEARTBEAT_${id}")" in',
        '      fail|1) exit 1 ;;',
        '      *) exit 0 ;;',
        '    esac',
        '    ;;',
        '  show)',
        '    n=$(inc_show_count)',
        '    max_fail=$(fixture_val "SHOW_FAIL_MAX_${id}" || true)',
        '    if [ -n "$max_fail" ] && [ "$n" -le "$max_fail" ]; then',
        '      exit 1',
        '    fi',
        '    if [ "$(fixture_val "SHOW_ALWAYS_FAIL_${id}")" = "1" ]; then',
        '      exit 1',
        '    fi',
        '    json=$(fixture_val "SHOW_JSON_${id}" || true)',
        '    if [ -z "$json" ]; then',
        '      json=$(printf \'[{"id":"%s","status":"in_progress"}]\' "$id")',
        '    fi',
        '    printf "%s\\n" "$json"',
        '    exit 0',
        '    ;;',
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(path.join(binDir, 'bd'), 0o755);

    const home = path.join(envRoot, 'home');
    mkdirSync(home, { recursive: true });
    const basePath = process.env.PATH ?? '/usr/bin:/bin';

    return {
      env: {
        PATH: `${binDir}${path.delimiter}${basePath}`,
        HOME: home,
        TMPDIR: tmpDir,
      },
      tmpDir,
      binDir,
      argsLog,
      fixturePath,
      counterDir,
    };
  }

  function writeFixture(fixturePath: string, lines: readonly string[]): void {
    writeFileSync(fixturePath, `${lines.join('\n')}\n`, 'utf8');
  }

  async function runHeartbeat(
    args: readonly string[],
    hbEnv: HeartbeatEnv,
    options?: { readonly cwd?: string; readonly timeoutMs?: number; readonly bash?: string },
  ): Promise<CommandResult> {
    const bash = options?.bash ?? 'bash';
    return runner.run(bash, [HEARTBEAT_SCRIPT, ...args], {
      cwd: options?.cwd ?? tmpRoot,
      env: hbEnv.env,
      timeoutMs: options?.timeoutMs ?? 20_000,
    });
  }

  async function killProcessByPid(pid: number, env: Record<string, string>): Promise<void> {
    await runner.run('kill', ['-TERM', String(pid)], {
      cwd: tmpRoot,
      env,
      timeoutMs: 5_000,
    }).catch(() => undefined);
  }

  function trackProcess(pid: number, env: Record<string, string>): void {
    trackedProcesses.push({ pid, env });
  }

  async function startSession(
    hbEnv: HeartbeatEnv,
    sleepSeconds = 120,
  ): Promise<SessionProcess> {
    const launch = await runner.run(
      'bash',
      ['-c', `sleep ${sleepSeconds} & echo $!`],
      { cwd: tmpRoot, env: hbEnv.env, timeoutMs: 5_000 },
    );
    const pid = Number.parseInt(launch.stdout.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`failed to start session sleep process: ${launch.stdout}`);
    }
    trackProcess(pid, hbEnv.env);
    return {
      pid,
      stop: async () => {
        await killProcessByPid(pid, hbEnv.env);
      },
    };
  }

  async function startDisposableSleep(
    hbEnv: HeartbeatEnv,
    sleepSeconds = 600,
  ): Promise<{ readonly pid: number; readonly kill: () => Promise<void> }> {
    const launch = await runner.run(
      'bash',
      ['-c', `sleep ${sleepSeconds} & echo $!`],
      { cwd: tmpRoot, env: hbEnv.env, timeoutMs: 5_000 },
    );
    const pid = Number.parseInt(launch.stdout.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`failed to start disposable sleep process: ${launch.stdout}`);
    }
    trackProcess(pid, hbEnv.env);
    return {
      pid,
      kill: async () => {
        await killProcessByPid(pid, hbEnv.env);
      },
    };
  }

  async function pollUntil(
    predicate: () => boolean | Promise<boolean>,
    options?: { readonly timeoutMs?: number; readonly intervalMs?: number },
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const intervalMs = options?.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
  }

  function callCount(argsLog: string, cmd: string, id: string): number {
    if (!existsSync(argsLog)) {
      return 0;
    }
    return readFileSync(argsLog, 'utf8')
      .split('\n')
      .filter((line) => line === `call cmd=${cmd} id=${id}`).length;
  }

  function heartbeatCallCount(argsLog: string, id: string): number {
    return callCount(argsLog, 'heartbeat', id);
  }

  function readPidfile(tmpDir: string, sessionPid: number): string | undefined {
    const pf = pidfilePath(tmpDir, sessionPid);
    if (!existsSync(pf)) {
      return undefined;
    }
    const line = readFileSync(pf, 'utf8').trim();
    const pidField = (line.split('\t')[0] ?? '').replace(/\s/g, '');
    if (!pidField || !/^\d+$/.test(pidField)) {
      return undefined;
    }
    const pidNum = Number.parseInt(pidField, 10);
    if (pidNum <= 1) {
      return undefined;
    }
    return pidField;
  }

  function writePidfileRaw(tmpDir: string, sessionPid: number, content: string): void {
    const dir = stateDir(tmpDir);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    writeFileSync(pidfilePath(tmpDir, sessionPid), content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }

  async function isPidAlive(pid: number, env: Record<string, string>): Promise<boolean> {
    const result = await runner.run('kill', ['-0', String(pid)], {
      cwd: tmpRoot,
      env,
      timeoutMs: 5_000,
    });
    return result.exitCode === 0;
  }

  it('keeps beating ids on interval (multiple heartbeat calls)', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok', 'HEARTBEAT_a-2=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    const start = await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.2',
        '--max-hours',
        '1',
        '--repo',
        tmpRoot,
        'a-1',
        'a-2',
      ],
      hbEnv,
    );
    expect(start.exitCode).toBe(0);

    await pollUntil(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 3, {
      timeoutMs: 15_000,
    });
    expect(heartbeatCallCount(hbEnv.argsLog, 'a-2')).toBeGreaterThanOrEqual(3);

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 30_000);

  it('drops an id when heartbeat fails and show reports non-in_progress', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, [
      'HEARTBEAT_drop-me=fail',
      'SHOW_JSON_drop-me=[{"id":"drop-me","status":"closed"}]',
      'HEARTBEAT_keep-me=ok',
    ]);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'drop-me',
        'keep-me',
      ],
      hbEnv,
    );

    await pollUntil(
      () =>
        heartbeatCallCount(hbEnv.argsLog, 'drop-me') >= 1
        && heartbeatCallCount(hbEnv.argsLog, 'keep-me') >= 2,
      { timeoutMs: 15_000 },
    );

    const dropCallsAfterWait = heartbeatCallCount(hbEnv.argsLog, 'drop-me');
    await pollUntil(() => heartbeatCallCount(hbEnv.argsLog, 'keep-me') >= dropCallsAfterWait + 2, {
      timeoutMs: 10_000,
    });

    expect(heartbeatCallCount(hbEnv.argsLog, 'drop-me')).toBe(1);
    expect(heartbeatCallCount(hbEnv.argsLog, 'keep-me')).toBeGreaterThan(1);

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntil(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('drop id=drop-me'), {
      timeoutMs: 10_000,
    });

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 30_000);

  it('drops after 3 consecutive show failures but keeps after 1-2', async () => {
    const hbEnvThree = setupEnv();
    writeFixture(hbEnvThree.fixturePath, [
      'HEARTBEAT_triple=fail',
      'SHOW_ALWAYS_FAIL_triple=1',
    ]);

    const sessionThree = await startSession(hbEnvThree);
    activeSessions.push({ sessionPid: sessionThree.pid, hbEnv: hbEnvThree, stopSession: sessionThree.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(sessionThree.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'triple',
      ],
      hbEnvThree,
    );

    const logThree = logfilePath(hbEnvThree.tmpDir, sessionThree.pid);
    await pollUntil(
      () => existsSync(logThree) && readFileSync(logThree, 'utf8').includes('reason=show-failed-3x'),
      { timeoutMs: 15_000 },
    );
    await pollUntil(() => readPidfile(hbEnvThree.tmpDir, sessionThree.pid) === undefined, {
      timeoutMs: 10_000,
    });

    await runHeartbeat(['stop', '--session-pid', String(sessionThree.pid)], hbEnvThree);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== sessionThree.pid);

    const hbEnvTwo = setupEnv();
    writeFixture(hbEnvTwo.fixturePath, [
      'HEARTBEAT_pair=fail',
      'SHOW_FAIL_MAX_pair=2',
      'SHOW_JSON_pair=[{"id":"pair","status":"in_progress"}]',
    ]);

    const sessionTwo = await startSession(hbEnvTwo);
    activeSessions.push({ sessionPid: sessionTwo.pid, hbEnv: hbEnvTwo, stopSession: sessionTwo.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(sessionTwo.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'pair',
      ],
      hbEnvTwo,
    );

    await pollUntil(() => heartbeatCallCount(hbEnvTwo.argsLog, 'pair') >= 4, {
      timeoutMs: 15_000,
    });

    const logTwo = logfilePath(hbEnvTwo.tmpDir, sessionTwo.pid);
    const logText = existsSync(logTwo) ? readFileSync(logTwo, 'utf8') : '';
    expect(logText).not.toContain('drop id=pair reason=show-failed-3x');
    const countBeforeWait = heartbeatCallCount(hbEnvTwo.argsLog, 'pair');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(heartbeatCallCount(hbEnvTwo.argsLog, 'pair')).toBeGreaterThan(countBeforeWait);

    await runHeartbeat(['stop', '--session-pid', String(sessionTwo.pid)], hbEnvTwo);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== sessionTwo.pid);
  }, 30_000);

  it('exits when the session pid goes away', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv, 60);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );

    const loopPidStr = readPidfile(hbEnv.tmpDir, session.pid);
    expect(loopPidStr).toBeDefined();

    await session.stop();

    await pollUntil(async () => {
      const pf = readPidfile(hbEnv.tmpDir, session.pid);
      if (pf !== undefined) {
        return false;
      }
      if (loopPidStr === undefined) {
        return true;
      }
      return !(await isPidAlive(Number.parseInt(loopPidStr, 10), hbEnv.env));
    }, { timeoutMs: 15_000 });

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntil(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('exit reason=session-gone'),
      { timeoutMs: 10_000 },
    );

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 30_000);

  it('exits when all ids have dropped', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, [
      'HEARTBEAT_only=fail',
      'SHOW_JSON_only=[{"id":"only","status":"closed"}]',
    ]);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'only',
      ],
      hbEnv,
    );

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntil(
      () =>
        existsSync(logPath)
        && readFileSync(logPath, 'utf8').includes('exit reason=no-ids'),
      { timeoutMs: 15_000 },
    );
    await pollUntil(() => readPidfile(hbEnv.tmpDir, session.pid) === undefined, {
      timeoutMs: 10_000,
    });

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 30_000);

  it('exits when --max-hours is reached', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_only=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.1',
        '--max-hours',
        '0.0001',
        '--repo',
        tmpRoot,
        'only',
      ],
      hbEnv,
    );

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntil(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('exit reason=max-hours'),
      { timeoutMs: 15_000 },
    );
    await pollUntil(() => readPidfile(hbEnv.tmpDir, session.pid) === undefined, {
      timeoutMs: 10_000,
    });

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 30_000);

  it('replaces the previous loop on start with the same session-pid', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );

    const firstPidStr = readPidfile(hbEnv.tmpDir, session.pid);
    expect(firstPidStr).toBeDefined();
    const firstPid = Number.parseInt(firstPidStr ?? '', 10);

    await pollUntil(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 1, {
      timeoutMs: 10_000,
    });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'a-1',
        'a-2',
      ],
      hbEnv,
    );

    const secondPidStr = readPidfile(hbEnv.tmpDir, session.pid);
    expect(secondPidStr).toBeDefined();
    expect(secondPidStr).not.toBe(firstPidStr);

    await pollUntil(async () => !(await isPidAlive(firstPid, hbEnv.env)), {
      timeoutMs: 15_000,
    });
    await pollUntil(async () => {
      const pid = readPidfile(hbEnv.tmpDir, session.pid);
      if (pid === undefined) {
        return false;
      }
      return isPidAlive(Number.parseInt(pid, 10), hbEnv.env);
    }, { timeoutMs: 10_000 });

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntil(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('replaced old-loop-pid='),
      { timeoutMs: 10_000 },
    );

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 30_000);

  it('stop does not kill unrelated processes when pidfile has invalid pid values', async () => {
    const hbEnv = setupEnv();
    const disposable = await startDisposableSleep(hbEnv);
    const sessionPid = 880_001;

    const invalidValues: Array<{ readonly content: string; readonly label: string }> = [
      { content: '-1\tfake-lstart', label: '-1' },
      { content: '0\tfake-lstart', label: '0' },
      { content: '1\tfake-lstart', label: '1' },
      { content: 'abc\tfake-lstart', label: 'abc' },
      { content: '\n', label: 'empty' },
    ];

    for (const { content, label } of invalidValues) {
      writePidfileRaw(hbEnv.tmpDir, sessionPid, content);

      const stop = await runHeartbeat(['stop', '--session-pid', String(sessionPid)], hbEnv);
      expect(stop.exitCode, label).toBe(0);
      expect(await isPidAlive(disposable.pid, hbEnv.env), label).toBe(true);
      expect(readPidfile(hbEnv.tmpDir, sessionPid), label).toBeUndefined();
    }

    await disposable.kill();
  }, 30_000);

  it('stop does not kill unrelated process when pidfile has stale unrelated pid', async () => {
    const hbEnv = setupEnv();
    const disposable = await startDisposableSleep(hbEnv);
    const sessionPid = 880_002;

    writePidfileRaw(hbEnv.tmpDir, sessionPid, `${disposable.pid}\n`);

    const stop = await runHeartbeat(['stop', '--session-pid', String(sessionPid)], hbEnv);
    expect(stop.exitCode).toBe(0);
    expect(await isPidAlive(disposable.pid, hbEnv.env)).toBe(true);
    expect(readPidfile(hbEnv.tmpDir, sessionPid)).toBeUndefined();

    const logPath = logfilePath(hbEnv.tmpDir, sessionPid);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toContain('stale-pidfile discarded');

    await disposable.kill();
  }, 30_000);

  it('status reports running, stopped, and stale with expected exit codes', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    let status = await runHeartbeat(['status', '--session-pid', String(session.pid)], hbEnv);
    expect(status.exitCode).toBe(1);
    expect(status.stdout.trim()).toBe('stopped');

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        '0.2',
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );
    await pollUntil(() => readPidfile(hbEnv.tmpDir, session.pid) !== undefined, {
      timeoutMs: 10_000,
    });

    status = await runHeartbeat(['status', '--session-pid', String(session.pid)], hbEnv);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(/^running pid=\d+ ids=a-1/);

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);

    status = await runHeartbeat(['status', '--session-pid', String(session.pid)], hbEnv);
    expect(status.exitCode).toBe(1);
    expect(status.stdout.trim()).toBe('stopped');

    const disposable = await startDisposableSleep(hbEnv);
    writePidfileRaw(hbEnv.tmpDir, session.pid, `${disposable.pid}\tfake-lstart`);
    writeFileSync(idsfilePath(hbEnv.tmpDir, session.pid), 'a-1\n', 'utf8');

    status = await runHeartbeat(['status', '--session-pid', String(session.pid)], hbEnv);
    expect(status.exitCode).toBe(1);
    expect(status.stdout).toMatch(/^stale pid=/);

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    await disposable.kill();
  }, 30_000);

  it('rejects invalid --interval and --max-hours without starting loop', async () => {
    const hbEnv = setupEnv();
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    const cases: Array<{ readonly args: readonly string[]; readonly label: string }> = [
      {
        label: 'interval with unit suffix',
        args: ['start', '--session-pid', String(session.pid), '--interval', '90s', '--repo', tmpRoot, 'a-1'],
      },
      {
        label: 'interval zero',
        args: ['start', '--session-pid', String(session.pid), '--interval', '0', '--repo', tmpRoot, 'a-1'],
      },
      {
        label: 'max-hours non-numeric',
        args: ['start', '--session-pid', String(session.pid), '--max-hours', 'abc', '--repo', tmpRoot, 'a-1'],
      },
    ];

    for (const { args, label } of cases) {
      const result = await runHeartbeat(args, hbEnv);
      expect(result.exitCode, label).toBe(2);
      expect(result.stderr, label).toMatch(/usage/i);
      expect(readPidfile(hbEnv.tmpDir, session.pid), label).toBeUndefined();
    }
  }, 30_000);

  it(
    'exits with reason=no-ids under /bin/bash 3.2 (empty array expansion regression)',
    async (ctx) => {
      const version = await detectBinBashMajorVersion();
      if (version !== 3) {
        ctx.skip();
        return;
      }

      const hbEnv = setupEnv();
      writeFixture(hbEnv.fixturePath, [
        'HEARTBEAT_only=fail',
        'SHOW_JSON_only=[{"id":"only","status":"closed"}]',
      ]);

      const session = await startSession(hbEnv);
      activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

      await runHeartbeat(
        [
          'start',
          '--session-pid',
          String(session.pid),
          '--interval',
          '0.2',
          '--repo',
          tmpRoot,
          'only',
        ],
        hbEnv,
        { bash: BASH32_PATH },
      );

      const logPath = logfilePath(hbEnv.tmpDir, session.pid);
      await pollUntil(
        () =>
          existsSync(logPath)
          && readFileSync(logPath, 'utf8').includes('exit reason=no-ids'),
        { timeoutMs: 15_000 },
      );
      await pollUntil(() => readPidfile(hbEnv.tmpDir, session.pid) === undefined, {
        timeoutMs: 10_000,
      });

      activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
    },
    30_000,
  );
});

describe.skipIf(process.platform === 'win32')('bdboard-harness pack shell scripts syntax', () => {
  const runner = new NodeCommandRunner();
  const bashForSyntaxCheck = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

  it('all pack *.sh pass bash -n', async () => {
    expect(SHELL_SCRIPTS.length).toBeGreaterThan(0);
    for (const script of SHELL_SCRIPTS) {
      const result = await runner.run(bashForSyntaxCheck, ['-n', script], {
        timeoutMs: 5_000,
      });
      expect(result.exitCode, script).toBe(0);
    }
  }, 30_000);
});
