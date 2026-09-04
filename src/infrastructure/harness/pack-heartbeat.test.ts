import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const runner = new NodeCommandRunner();

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

describe.skipIf(process.platform === 'win32')('bdboard-harness pack bd-heartbeat.sh', () => {
  let tmpRoot: string;
  let activeSessions: Array<{
    readonly sessionPid: number;
    readonly hbEnv: HeartbeatEnv;
    readonly stopSession: () => Promise<void>;
  }> = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-pack-heartbeat-'));
    activeSessions = [];
  });

  afterEach(async () => {
    for (const { sessionPid, hbEnv, stopSession } of activeSessions) {
      await runHeartbeat(['stop', '--session-pid', String(sessionPid)], hbEnv).catch(() => {
        /* best-effort */
      });
      await stopSession().catch(() => {
        /* best-effort */
      });
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setupEnv(): HeartbeatEnv {
    const tmpDir = path.join(tmpRoot, 'state');
    mkdirSync(tmpDir, { recursive: true });

    const binDir = path.join(tmpRoot, 'bin');
    mkdirSync(binDir, { recursive: true });

    const argsLog = path.join(tmpRoot, 'bd-args.log');
    const fixturePath = path.join(tmpRoot, 'bd-fixture.env');
    const counterDir = path.join(tmpRoot, 'counters');
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

    const home = path.join(tmpRoot, 'home');
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
    options?: { readonly cwd?: string; readonly timeoutMs?: number },
  ): Promise<CommandResult> {
    return runner.run('bash', [HEARTBEAT_SCRIPT, ...args], {
      cwd: options?.cwd ?? tmpRoot,
      env: hbEnv.env,
      timeoutMs: options?.timeoutMs ?? 20_000,
    });
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
    return {
      pid,
      stop: async () => {
        await runner.run('kill', ['-TERM', String(pid)], {
          cwd: tmpRoot,
          env: hbEnv.env,
          timeoutMs: 5_000,
        }).catch(() => undefined);
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
    const pf = path.join(tmpDir, `bd-heartbeat.${sessionPid}.pid`);
    if (!existsSync(pf)) {
      return undefined;
    }
    return readFileSync(pf, 'utf8').trim();
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
  });

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

    const logPath = path.join(hbEnv.tmpDir, `bd-heartbeat.${session.pid}.log`);
    await pollUntil(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('drop id=drop-me'), {
      timeoutMs: 10_000,
    });

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  });

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

    const logThree = path.join(hbEnvThree.tmpDir, `bd-heartbeat.${sessionThree.pid}.log`);
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

    const logTwo = path.join(hbEnvTwo.tmpDir, `bd-heartbeat.${sessionTwo.pid}.log`);
    const logText = existsSync(logTwo) ? readFileSync(logTwo, 'utf8') : '';
    expect(logText).not.toContain('drop id=pair reason=show-failed-3x');
    expect(heartbeatCallCount(hbEnvTwo.argsLog, 'pair')).toBeGreaterThanOrEqual(4);

    await runHeartbeat(['stop', '--session-pid', String(sessionTwo.pid)], hbEnvTwo);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== sessionTwo.pid);
  });

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

    const logPath = path.join(hbEnv.tmpDir, `bd-heartbeat.${session.pid}.log`);
    await pollUntil(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('exit reason=session-gone'),
      { timeoutMs: 10_000 },
    );

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  });

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

    const logPath = path.join(hbEnv.tmpDir, `bd-heartbeat.${session.pid}.log`);
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
  });

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

    const logPath = path.join(hbEnv.tmpDir, `bd-heartbeat.${session.pid}.log`);
    await pollUntil(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('replaced old-loop-pid='),
      { timeoutMs: 10_000 },
    );

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  });
});
