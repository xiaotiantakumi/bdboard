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

  /**
   * `ps` を PATH でシムして `session_lstart()` の応答をテストから操作する seam
   * (bdboard-69w1)。既定は実 ps への委譲で、制御ファイルが置かれた pid の
   * `ps -o lstart= -p <pid>` だけを差し替える (`-o command=` は常に素通し)。
   *
   * これが無いと bd-heartbeat.sh の「lstart が空/相違」分岐に決定的なカバレッジが
   * 作れない。実負荷で kill -0 と ps の窓を踏ませるのは再現性が無く、
   * `exit reason=session-pid-reused` に至ってはリポジトリのどこからも到達しない
   * ままになる。制御ファイルは counterDir に置き、bd シムと同じ流儀で読む。
   */
  function installPsShim(hbEnv: HeartbeatEnv): void {
    writeFileSync(
      path.join(hbEnv.binDir, 'ps'),
      [
        '#!/bin/sh',
        `CONTROL_DIR='${hbEnv.counterDir}'`,
        'REAL_PS=""',
        'for cand in /bin/ps /usr/bin/ps; do',
        '  if [ -x "$cand" ]; then REAL_PS="$cand"; break; fi',
        'done',
        '[ -n "$REAL_PS" ] || exit 1',
        '',
        'want_lstart=0',
        'pid=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "-p" ]; then pid="$arg"; fi',
        '  if [ "$arg" = "lstart=" ]; then want_lstart=1; fi',
        '  prev="$arg"',
        'done',
        '',
        'if [ "$want_lstart" = "1" ] && [ -n "$pid" ]; then',
        '  if [ -f "$CONTROL_DIR/ps-lstart-kill-$pid" ]; then',
        '    # kill -0 が通った後・ps が答える前にセッションが死ぬ窓を決定的に開ける',
        '    kill -TERM "$pid" 2>/dev/null || true',
        '    i=0',
        '    while [ "$i" -lt 200 ]; do',
        '      kill -0 "$pid" 2>/dev/null || break',
        '      sleep 0.05',
        '      i=$((i + 1))',
        '    done',
        '    exit 0',
        '  fi',
        '  if [ -f "$CONTROL_DIR/ps-lstart-fake-$pid" ]; then',
        '    cat "$CONTROL_DIR/ps-lstart-fake-$pid"',
        '    exit 0',
        '  fi',
        '  f="$CONTROL_DIR/ps-lstart-empty-$pid"',
        '  if [ -f "$f" ]; then',
        '    n=$(cat "$f" 2>/dev/null || echo 0)',
        '    case "$n" in',
        '      \'\'|*[!0-9]*) n=0 ;;',
        '    esac',
        '    if [ "$n" -gt 0 ]; then',
        '      echo $((n - 1)) > "$f"',
        '      exit 0',
        '    fi',
        '  fi',
        'fi',
        '',
        'exec "$REAL_PS" "$@"',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(path.join(hbEnv.binDir, 'ps'), 0o755);
  }

  /** 次の `times` 回だけ `ps -o lstart=` を空応答にする (ps 自体の一過性失敗を模す)。 */
  function psLstartEmpty(hbEnv: HeartbeatEnv, pid: number, times: number): void {
    writeFileSync(path.join(hbEnv.counterDir, `ps-lstart-empty-${pid}`), `${times}\n`, 'utf8');
  }

  /** `ps -o lstart=` が呼ばれた瞬間にセッションを殺してから空応答を返す。 */
  function psLstartKillsSession(hbEnv: HeartbeatEnv, pid: number): void {
    writeFileSync(path.join(hbEnv.counterDir, `ps-lstart-kill-${pid}`), '1\n', 'utf8');
  }

  /** `ps -o lstart=` に baseline と異なる非空の値を返させる (真の PID 再利用を模す)。 */
  function psLstartFake(hbEnv: HeartbeatEnv, pid: number, lstart: string): void {
    writeFileSync(path.join(hbEnv.counterDir, `ps-lstart-fake-${pid}`), `${lstart}\n`, 'utf8');
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

  /**
   * 単純な壁時計待ち。`what` は省略可能だが、省略すると失敗メッセージが
   * `pollUntil timed out after 15000ms` だけになり「何を待っていたのか」が消える。
   * 本チケットの診断が高くついた直接の原因がこれなので、呼び出し側は必ず渡す
   * (bdboard-69w1)。session.stop() は kill の失敗を .catch(() => undefined) で
   * 握り潰すため、kill が効かなかったケースもこの匿名タイムアウトとして表面化する。
   */
  async function pollUntil(
    predicate: () => boolean | Promise<boolean>,
    options?: {
      readonly timeoutMs?: number;
      readonly intervalMs?: number;
      readonly what?: string;
    },
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
    throw new Error(`${options?.what ?? 'pollUntil'} timed out after ${timeoutMs}ms`);
  }

  /**
   * 進捗が続く限り待ち続け、「進捗が止まったこと」で失敗を判定する待機 (bdboard-rg8o)。
   *
   * 壁時計デッドラインだけで待つと、マシンが遅いだけの状況と「ループが止まった」
   * 退行とを区別できず、高負荷時に偽陽性で落ちる。ここでは判定基準を時間ではなく
   * 「監視対象 id ごとの counts() の最小値が伸び続けているか」に置く: 遅いだけなら
   * いくらでも待ち、stallMs の間まったく進捗が無いときにだけ失敗する。maxMs は
   * テストが永久にぶら下がらないための最後の歯止めであって、通常の合否判定には
   * 使われない。stallMs は intervalSec から導出する (明示指定があればそれを優先)。
   */
  async function pollUntilProgressing(
    predicate: () => boolean | Promise<boolean>,
    options: {
      readonly counts: () => Record<string, number>;
      readonly what: string;
      readonly stallMs?: number;
      readonly maxMs?: number;
      readonly intervalMs?: number;
      readonly intervalSec?: number;
    },
  ): Promise<void> {
    const progressFromCounts = (counts: Record<string, number>): number => {
      const values = Object.values(counts);
      return values.length === 0 ? 0 : Math.min(...values);
    };
    const formatCountsBreakdown = (counts: Record<string, number>): string =>
      Object.entries(counts).map(([id, n]) => `${id}=${n}`).join(', ');

    const stallMs = options.stallMs ?? Math.max(10_000, (options.intervalSec ?? 0) * 1000 * 5);
    const maxMs = options.maxMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 100;
    const startedAt = Date.now();
    let lastProgress = progressFromCounts(options.counts());
    let lastProgressAt = startedAt;

    for (;;) {
      if (await predicate()) {
        return;
      }
      const currentCounts = options.counts();
      const current = progressFromCounts(currentCounts);
      const breakdown = formatCountsBreakdown(currentCounts);
      const now = Date.now();
      if (current > lastProgress) {
        lastProgress = current;
        lastProgressAt = now;
      } else if (now - lastProgressAt >= stallMs) {
        throw new Error(
          `${options.what}: no progress for ${stallMs}ms (progress stuck at ${lastProgress}; ${breakdown}); `
          + 'the heartbeat loop appears to have stopped beating',
        );
      }
      if (now - startedAt >= maxMs) {
        throw new Error(
          `${options.what}: hard cap ${maxMs}ms reached while still progressing (progress=${lastProgress}; ${breakdown})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /**
   * 「止まるはずのループが止まったこと」を待つ待機 (bdboard-69w1)。
   *
   * pollUntilProgressing の双対。あちらは「進捗が続く限り待ち、止まったら失敗」、
   * こちらは「余計な進捗が出ない限り待ち、出続けたら失敗」。
   *
   * 壁時計デッドラインで待つと、「マシンが遅くてループがまだ 1 周していないだけ」と
   * 「セッションが消えてもループが生き残った」退行とを区別できず、高負荷で偽陽性に
   * なる。ここでは判定基準を時間ではなく extraBeats() — 停止すべき事象が起きた後に
   * 追加で観測されたビート数 — に置く。健全なループが余分に打てる回数はループ 1 周の
   * 構造で決まっていて負荷では増えない (遅いマシンは 1 周が遅くなるだけ)。逆に
   * ループが生き残る退行では、どれだけ遅くてもビートは際限なく積み上がるので必ず
   * maxExtraBeats を超える。
   *
   * extraBeats() は原則「停止すべき事象の時点で取った baseline からの差分」だが、
   * その事象がループ開始そのもの (= 健全な総ビート数が構造的に有界) の場合は、
   * baseline を引かない絶対値をそのまま渡してよい。実際 `reason=no-ids` /
   * `reason=max-hours` の呼び出し側は絶対値を渡している — 健全な総数がそれぞれ
   * 1 回 / 3 回前後に決まっているので、差分と絶対値の検出力は変わらない。
   *
   * maxMs は「止まりも進みもしない (wedged)」ときにテストが永久にぶら下がらない
   * ための最後の歯止めであって、通常の合否判定には使われない。diagnose() は
   * maxMs に当たったときだけ評価され、メッセージに実ログを差し込む。
   */
  async function pollUntilStopped(
    predicate: () => boolean | Promise<boolean>,
    options: {
      readonly extraBeats: () => number;
      readonly maxExtraBeats: number;
      readonly what: string;
      readonly maxMs?: number;
      readonly intervalMs?: number;
      readonly diagnose?: () => string;
    },
  ): Promise<void> {
    const maxMs = options.maxMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 100;
    const startedAt = Date.now();

    for (;;) {
      if (await predicate()) {
        return;
      }
      const extra = options.extraBeats();
      if (extra > options.maxExtraBeats) {
        throw new Error(
          `${options.what}: ${extra} extra heartbeats observed after the loop should have stopped `
          + `(allowed ${options.maxExtraBeats}); the heartbeat loop appears to have survived`,
        );
      }
      if (Date.now() - startedAt >= maxMs) {
        // ここに来る典型は「ループは正しく止まったが exit reason が期待と違う」で、
        // ビートは増えないまま述語だけが偽り続ける。かつての文言
        // 「neither finished stopping nor kept beating」は起きたことの逆を断言して
        // いて、読んだ人をマシン負荷の調査へ誘導していた (bdboard-69w1)。
        const diagnosis = options.diagnose?.() ?? '';
        throw new Error(
          `${options.what}: hard cap ${maxMs}ms reached (extra heartbeats=${extra}); `
          + 'the stop condition never became true although no extra beats accumulated — '
          + 'the loop most likely stopped for a different reason'
          + (diagnosis === '' ? '' : `; ${diagnosis}`),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
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

  /**
   * pollUntilStopped の hard cap メッセージに差し込む heartbeat ログ末尾
   * (bdboard-69w1)。hard cap に当たるのはたいてい「止まりはしたが exit reason が
   * 期待と違う」ケースで、そのとき読みたいのは実際に書かれた `exit reason=` 行そのもの。
   */
  function logTail(logPath: string, lines = 8): string {
    if (!existsSync(logPath)) {
      return 'heartbeat log: (not created)';
    }
    const text = readFileSync(logPath, 'utf8').trimEnd();
    if (text === '') {
      return 'heartbeat log: (empty)';
    }
    return `heartbeat log tail: ${text.split('\n').slice(-lines).join(' | ')}`;
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

  // 待機は壁時計デッドラインではなく「heartbeat が増え続けているか」で判定する。
  // 高負荷でも遅いだけなら待ち、ループが実際に止まったときだけ落ちる (bdboard-rg8o)。
  //
  // per-test timeout の予算 (bdboard-69w1): startSession 5s + start 20s +
  // 進捗待ち 20s + stop 20s = 最悪 65s < 90s。段の合計が per-test timeout を
  // 超えていると、先に vitest の `test timed out in ...` が出て、この PR が
  // 作り込んだ診断メッセージが丸ごと失われる。
  it('keeps beating ids on interval (multiple heartbeat calls)', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
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
        String(HEARTBEAT_INTERVAL_SEC),
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

    // 両方の id が 3 回に達するまでを1つの述語で待つ。ループは1周ごとに
    // a-1 → a-2 の順で打つので、a-1 だけを待って a-2 をハードアサートすると
    // 「a-1 は 3 回目を打ったが a-2 はまだ 2 回」の窓を踏む (bdboard-rg8o)。
    await pollUntilProgressing(
      () =>
        heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 3
        && heartbeatCallCount(hbEnv.argsLog, 'a-2') >= 3,
      {
        counts: () => ({
          'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1'),
          'a-2': heartbeatCallCount(hbEnv.argsLog, 'a-2'),
        }),
        what: 'waiting for 3 heartbeats per id',
        intervalSec: HEARTBEAT_INTERVAL_SEC,
        maxMs: 20_000,
      },
    );

    expect(heartbeatCallCount(hbEnv.argsLog, 'a-1')).toBeGreaterThanOrEqual(3);
    expect(heartbeatCallCount(hbEnv.argsLog, 'a-2')).toBeGreaterThanOrEqual(3);

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 90_000);

  // 予算 (bdboard-69w1): startSession 5s + start 20s + 進捗待ち 20s + 進捗待ち 20s
  // + drop ログ待ち 10s + stop 20s = 最悪 95s < 120s。
  it('drops an id when heartbeat fails and show reports non-in_progress', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
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
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'drop-me',
        'keep-me',
      ],
      hbEnv,
    );

    await pollUntilProgressing(
      () =>
        heartbeatCallCount(hbEnv.argsLog, 'drop-me') >= 1
        && heartbeatCallCount(hbEnv.argsLog, 'keep-me') >= 2,
      {
        counts: () => ({
          'drop-me': heartbeatCallCount(hbEnv.argsLog, 'drop-me'),
          'keep-me': heartbeatCallCount(hbEnv.argsLog, 'keep-me'),
        }),
        what: 'waiting for the first beats',
        intervalSec: HEARTBEAT_INTERVAL_SEC,
        maxMs: 20_000,
      },
    );

    const dropCallsAfterWait = heartbeatCallCount(hbEnv.argsLog, 'drop-me');
    await pollUntilProgressing(
      () => heartbeatCallCount(hbEnv.argsLog, 'keep-me') >= dropCallsAfterWait + 2,
      {
        counts: () => ({
          'keep-me': heartbeatCallCount(hbEnv.argsLog, 'keep-me'),
        }),
        what: 'waiting for keep-me to keep beating after drop-me was dropped',
        intervalSec: HEARTBEAT_INTERVAL_SEC,
        maxMs: 20_000,
      },
    );

    expect(heartbeatCallCount(hbEnv.argsLog, 'drop-me')).toBe(1);
    expect(heartbeatCallCount(hbEnv.argsLog, 'keep-me')).toBeGreaterThan(1);

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntil(() => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('drop id=drop-me'), {
      timeoutMs: 10_000,
      what: 'waiting for the drop of drop-me to be logged',
    });

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 120_000);

  // 予算 (bdboard-69w1): セッション 2 本ぶん。各本 startSession 5s + start 20s +
  // 待機 20s×2 + stop 20s = 85s、合計で最悪 170s < 200s。
  it('drops after 3 consecutive show failures but keeps after 1-2', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
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
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'triple',
      ],
      hbEnvThree,
    );

    const logThree = logfilePath(hbEnvThree.tmpDir, sessionThree.pid);
    // show の 3 連続失敗にはループ 3 周が要る。壁時計 15s だと「高負荷で 3 周が
    // 入らなかっただけ」でも落ちるので、triple のビートが伸びているかで待つ
    // (bdboard-69w1)。ループが止まればビートも止まり stall で落ちる。
    // 監視量 (triple のビート) が止まるのは述語が真になるのと同じ瞬間 —
    // drop がログに書かれてから ids が空になるので、先に stall と判定されることはない。
    await pollUntilProgressing(
      () => existsSync(logThree) && readFileSync(logThree, 'utf8').includes('reason=show-failed-3x'),
      {
        counts: () => ({ triple: heartbeatCallCount(hbEnvThree.argsLog, 'triple') }),
        what: 'waiting for 3 consecutive show failures to drop the id',
        intervalSec: HEARTBEAT_INTERVAL_SEC,
        maxMs: 20_000,
      },
    );
    // pidfile 掃除の待ちは同ファイル内で pollUntilStopped に揃える (bdboard-69w1)。
    const beatsAtDrop = heartbeatCallCount(hbEnvThree.argsLog, 'triple');
    await pollUntilStopped(
      () => readPidfile(hbEnvThree.tmpDir, sessionThree.pid) === undefined,
      {
        extraBeats: () => heartbeatCallCount(hbEnvThree.argsLog, 'triple') - beatsAtDrop,
        maxExtraBeats: 3,
        what: 'waiting for the loop to remove its pidfile after the id was dropped',
        maxMs: 20_000,
        diagnose: () => logTail(logThree),
      },
    );

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
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'pair',
      ],
      hbEnvTwo,
    );

    // 4 周ぶんの待ち。閾値 4 は据え置きで、判定だけ時間から進捗へ移す (bdboard-69w1)。
    await pollUntilProgressing(() => heartbeatCallCount(hbEnvTwo.argsLog, 'pair') >= 4, {
      counts: () => ({ pair: heartbeatCallCount(hbEnvTwo.argsLog, 'pair') }),
      what: 'waiting for 4 beats on pair',
      intervalSec: HEARTBEAT_INTERVAL_SEC,
      maxMs: 20_000,
    });

    const logTwo = logfilePath(hbEnvTwo.tmpDir, sessionTwo.pid);
    const logText = existsSync(logTwo) ? readFileSync(logTwo, 'utf8') : '';
    expect(logText).not.toContain('drop id=pair reason=show-failed-3x');
    const countBeforeWait = heartbeatCallCount(hbEnvTwo.argsLog, 'pair');
    // 「実時間 800ms 待って 1 回以上増えていること」を直に assert していたが、高負荷では
    // ループ 1 周が 800ms を超えうる。遅いだけならいくらでも待ち、まったく増えなく
    // なったときにだけ落とす (bdboard-69w1)。検出したい退行 (1-2 回の show 失敗で
    // pair を drop してしまう = 打つのをやめる) は stall として捕まる。
    await pollUntilProgressing(
      () => heartbeatCallCount(hbEnvTwo.argsLog, 'pair') > countBeforeWait,
      {
        counts: () => ({ pair: heartbeatCallCount(hbEnvTwo.argsLog, 'pair') }),
        what: 'waiting for pair to keep beating after 1-2 show failures',
        intervalSec: HEARTBEAT_INTERVAL_SEC,
        maxMs: 20_000,
      },
    );
    expect(heartbeatCallCount(hbEnvTwo.argsLog, 'pair')).toBeGreaterThan(countBeforeWait);

    await runHeartbeat(['stop', '--session-pid', String(sessionTwo.pid)], hbEnvTwo);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== sessionTwo.pid);
  }, 200_000);

  // 待機は壁時計デッドラインではなく「セッション消失後に余分に打たれたビート数」で
  // 判定する。遅いだけならいくらでも待ち、ループが生き残ったときだけ落ちる
  // (bdboard-69w1)。
  //
  // 予算: startSession 5s + start 20s + 進捗待ち 20s + セッション消失待ち 10s +
  // 停止待ち 20s×2 = 最悪 95s < 120s。
  it('exits when the session pid goes away', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
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
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );

    const loopPidStr = readPidfile(hbEnv.tmpDir, session.pid);
    expect(loopPidStr).toBeDefined();

    // 殺す前に、ループが実際に回っていたことを確定させる。ここを飛ばすと後段の
    // 「止まった」が、消失を検知した結果なのか、そもそも一度も回っていなかった
    // だけなのかを区別できない。
    await pollUntilProgressing(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 1, {
      counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
      what: 'waiting for the loop to start beating',
      intervalSec: HEARTBEAT_INTERVAL_SEC,
      maxMs: 20_000,
    });

    await session.stop();

    // kill -TERM は非同期。「消失後に何ビート打たれたか」の基準点を確定させるため、
    // セッションが本当に消えたことをここで確認してから baseline を取る。
    await pollUntil(async () => !(await isPidAlive(session.pid, hbEnv.env)), {
      timeoutMs: 10_000,
      what: 'waiting for the session sleep process to actually die after kill -TERM',
    });

    // ループ 1 周は「セッション生存チェック → 各 id を beat → sleep」の順なので、
    // 消失を確認した時点で進行中だった 1 周ぶん (= 1 ビート) までは健全でも観測
    // されうる。3 はその 3 倍の余裕で、負荷が上がっても動かない上限 (遅いマシンでは
    // 1 周が遅くなるだけで、余分なビートが増えるわけではない)。
    const beatsAtSessionDeath = heartbeatCallCount(hbEnv.argsLog, 'a-1');
    const extraBeats = (): number =>
      heartbeatCallCount(hbEnv.argsLog, 'a-1') - beatsAtSessionDeath;

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntilStopped(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('exit reason=session-gone'),
      {
        extraBeats,
        maxExtraBeats: 3,
        what: 'waiting for the loop to log exit reason=session-gone',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      },
    );

    // ここが捕まえるのは「exit reason は書いたのに break し損ねた」退行。その退行では
    // ループが次の周へ入って beat が積み上がるので extraBeats が budget を超える。
    // 健全なら break 後に残るのは rm -f とプロセス終了だけなので、beat は 1 回も
    // 増えないまま述語が真になる。
    await pollUntilStopped(
      async () => {
        const pf = readPidfile(hbEnv.tmpDir, session.pid);
        if (pf !== undefined) {
          return false;
        }
        if (loopPidStr === undefined) {
          return true;
        }
        return !(await isPidAlive(Number.parseInt(loopPidStr, 10), hbEnv.env));
      },
      {
        extraBeats,
        maxExtraBeats: 3,
        what: 'waiting for the loop to remove its pidfile and exit',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      },
    );

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 120_000);

  // --- session_lstart (ps) の失敗と PID 再利用の分類 (bdboard-69w1) ---
  //
  // ループ内の分類ブロックは「kill -0 は通ったが ps の応答が空/相違」という窓に
  // しか入らない。実負荷でその窓を踏ませるのは再現性が無く、結果として
  // `exit reason=session-pid-reused` はリポジトリのどこからも到達しないままだった。
  // installPsShim() で ps を差し替え、4 つの分岐すべてを決定的に固定する。

  // 予算: startSession 5s + start 20s + 進捗待ち 20s×3 + stop 20s = 最悪 105s < 120s。
  it('keeps beating when ps fails transiently below the 3-strike threshold', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
    const hbEnv = setupEnv();
    installPsShim(hbEnv);
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    const start = await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );
    expect(start.exitCode).toBe(0);

    // ここまで来ればループ開始時の baseline 読み取りは終わっている。以降 2 回だけ
    // ps を空にする — 3 連続には届かないので、ループは分類せずに beat を続けるはず。
    await pollUntilProgressing(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 1, {
      counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
      what: 'waiting for the loop to start beating before failing ps',
      intervalSec: HEARTBEAT_INTERVAL_SEC,
      maxMs: 20_000,
    });
    psLstartEmpty(hbEnv, session.pid, 2);

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntilProgressing(
      () =>
        existsSync(logPath)
        && readFileSync(logPath, 'utf8').includes('session-lstart-unreadable consecutive=2'),
      {
        counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
        what: 'waiting for 2 consecutive unreadable lstart reads',
        intervalSec: HEARTBEAT_INTERVAL_SEC,
        maxMs: 20_000,
      },
    );

    // 一過性の失敗を跨いでも打ち続けていること。ここが本題 — 生存中セッションの
    // heartbeat を ps の一時的失敗で見殺しにしない。
    const beatsAfterStrikes = heartbeatCallCount(hbEnv.argsLog, 'a-1');
    await pollUntilProgressing(
      () => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= beatsAfterStrikes + 2,
      {
        counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
        what: 'waiting for the loop to keep beating after the transient ps failures',
        intervalSec: HEARTBEAT_INTERVAL_SEC,
        maxMs: 20_000,
      },
    );

    const logText = readFileSync(logPath, 'utf8');
    expect(logText).toContain('session-lstart-unreadable consecutive=1');
    expect(logText).toContain('session-lstart-unreadable consecutive=2');
    expect(logText).not.toContain('exit reason=');

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 120_000);

  // 予算: startSession 5s + start 20s + 進捗待ち 20s + 停止待ち 20s + stop 20s
  // = 最悪 85s < 120s。
  it('exits with reason=session-lstart-unavailable after 3 consecutive ps failures', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
    const hbEnv = setupEnv();
    installPsShim(hbEnv);
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );

    await pollUntilProgressing(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 1, {
      counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
      what: 'waiting for the loop to start beating before failing ps',
      intervalSec: HEARTBEAT_INTERVAL_SEC,
      maxMs: 20_000,
    });

    const beatsBeforeFailure = heartbeatCallCount(hbEnv.argsLog, 'a-1');
    psLstartEmpty(hbEnv, session.pid, 999);

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    // 健全な脱落までに余分に打たれるのは 2 周ぶん (1 回目・2 回目の strike は
    // beat を続ける)。5 はその余裕で、「いつまでも抜けない」退行では際限なく増える。
    await pollUntilStopped(
      () =>
        existsSync(logPath)
        && readFileSync(logPath, 'utf8').includes('exit reason=session-lstart-unavailable'),
      {
        extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'a-1') - beatsBeforeFailure,
        maxExtraBeats: 5,
        what: 'waiting for the loop to exit with reason=session-lstart-unavailable',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      },
    );

    const logText = readFileSync(logPath, 'utf8');
    expect(logText).toContain('session-lstart-unreadable consecutive=1');
    expect(logText).toContain('session-lstart-unreadable consecutive=2');
    // 起きていない PID 再利用を報告しないこと。セッションは生きたままなので
    // session-gone も誤り。
    expect(logText).not.toContain('exit reason=session-pid-reused');
    expect(logText).not.toContain('exit reason=session-gone');
    expect(await isPidAlive(session.pid, hbEnv.env)).toBe(true);

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 120_000);

  // 本チケットの元になったレースそのものの再現。ps シムが呼ばれた瞬間に
  // セッションを殺すので、「kill -0 は通る → ps は空」の窓に必ず入る。
  // 予算: startSession 5s + start 20s + 進捗待ち 20s + 停止待ち 20s = 最悪 65s < 90s。
  it('classifies a session that dies between kill -0 and ps as session-gone', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
    const hbEnv = setupEnv();
    installPsShim(hbEnv);
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );

    await pollUntilProgressing(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 1, {
      counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
      what: 'waiting for the loop to start beating before opening the race window',
      intervalSec: HEARTBEAT_INTERVAL_SEC,
      maxMs: 20_000,
    });

    const beatsBeforeRace = heartbeatCallCount(hbEnv.argsLog, 'a-1');
    psLstartKillsSession(hbEnv, session.pid);

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntilStopped(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('exit reason=session-gone'),
      {
        extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'a-1') - beatsBeforeRace,
        maxExtraBeats: 3,
        what: 'waiting for the loop to log exit reason=session-gone after the ps race',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      },
    );

    // 起きていない PID 再利用を報告しないこと — これが本チケットの本体。
    expect(readFileSync(logPath, 'utf8')).not.toContain('exit reason=session-pid-reused');

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 90_000);

  // 予算: startSession 5s + start 20s + 進捗待ち 20s + 停止待ち 20s + stop 20s
  // = 最悪 85s < 120s。
  it('logs session-pid-reused when ps reports a different lstart for a live session', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
    const hbEnv = setupEnv();
    installPsShim(hbEnv);
    writeFixture(hbEnv.fixturePath, ['HEARTBEAT_a-1=ok']);

    const session = await startSession(hbEnv);
    activeSessions.push({ sessionPid: session.pid, hbEnv, stopSession: session.stop });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );

    await pollUntilProgressing(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 1, {
      counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
      what: 'waiting for the loop to start beating before faking a reused pid',
      intervalSec: HEARTBEAT_INTERVAL_SEC,
      maxMs: 20_000,
    });

    const beatsBeforeReuse = heartbeatCallCount(hbEnv.argsLog, 'a-1');
    // 非空かつ baseline と相違 = 実際に観測された再利用。セッションは生きているので、
    // 生死の取り直しで session-gone へ格下げされてはならない。
    psLstartFake(hbEnv, session.pid, 'Thu Jan  1 00:00:00 1970');

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntilStopped(
      () =>
        existsSync(logPath)
        && readFileSync(logPath, 'utf8').includes('exit reason=session-pid-reused'),
      {
        extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'a-1') - beatsBeforeReuse,
        maxExtraBeats: 3,
        what: 'waiting for the loop to exit with reason=session-pid-reused',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      },
    );

    const logText = readFileSync(logPath, 'utf8');
    expect(logText).not.toContain('exit reason=session-gone');
    expect(logText).not.toContain('exit reason=session-lstart-unavailable');

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 120_000);

  // 予算 (bdboard-69w1): startSession 5s + start 20s + 停止待ち 20s +
  // pidfile 掃除待ち 20s = 最悪 65s < 90s。
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
    // 健全なループは only を 1 回だけ打ち、show が closed を返すので drop → no-ids で
    // 抜ける。3 はその 3 倍の余裕。「drop されず打ち続ける」退行なら、どれだけ遅い
    // マシンでもビートが積み上がって budget を超える (bdboard-69w1)。
    await pollUntilStopped(
      () =>
        existsSync(logPath)
        && readFileSync(logPath, 'utf8').includes('exit reason=no-ids'),
      {
        extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'only'),
        maxExtraBeats: 3,
        what: 'waiting for the loop to exit with reason=no-ids',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      },
    );
    await pollUntilStopped(() => readPidfile(hbEnv.tmpDir, session.pid) === undefined, {
      extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'only'),
      maxExtraBeats: 3,
      what: 'waiting for the loop to remove its pidfile',
      maxMs: 20_000,
      diagnose: () => logTail(logPath),
    });

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 90_000);

  // 予算 (bdboard-69w1): startSession 5s + start 20s + 停止待ち 20s +
  // pidfile 掃除待ち 20s = 最悪 65s < 90s。
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
    // interval 0.1s / max-hours 0.0001h (= 0.36s) なので健全時のビートは 3 回前後。
    // 20 は 6 倍以上の余裕で、しかも遅いマシンほど周回数は減る (max-hours の引き金は
    // 経過実時間なので、1 周が遅いと少ない周回数で到達する)。max-hours ベルトが
    // 効かない退行ではビートが際限なく増えるので必ず超える (bdboard-69w1)。
    await pollUntilStopped(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('exit reason=max-hours'),
      {
        extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'only'),
        maxExtraBeats: 20,
        what: 'waiting for the loop to exit with reason=max-hours',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      },
    );
    await pollUntilStopped(() => readPidfile(hbEnv.tmpDir, session.pid) === undefined, {
      extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'only'),
      maxExtraBeats: 20,
      what: 'waiting for the loop to remove its pidfile',
      maxMs: 20_000,
      diagnose: () => logTail(logPath),
    });

    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 90_000);

  // 予算 (bdboard-69w1): startSession 5s + start 20s + 進捗待ち 20s + start 20s +
  // 旧ループ消滅待ち 10s + 新 pidfile 待ち 10s + replaced ログ待ち 10s + stop 20s
  // = 最悪 115s < 150s。
  it('replaces the previous loop on start with the same session-pid', async () => {
    const HEARTBEAT_INTERVAL_SEC = 0.2;
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
        String(HEARTBEAT_INTERVAL_SEC),
        '--repo',
        tmpRoot,
        'a-1',
      ],
      hbEnv,
    );

    const firstPidStr = readPidfile(hbEnv.tmpDir, session.pid);
    expect(firstPidStr).toBeDefined();
    const firstPid = Number.parseInt(firstPidStr ?? '', 10);

    // 「1 回以上打たれた」を壁時計 10s で待っていたが、これも高負荷でループ 1 周が
    // 入らないだけで落ちうる反復依存の待ち。他と同じく進捗基準へ揃える (bdboard-69w1)。
    await pollUntilProgressing(() => heartbeatCallCount(hbEnv.argsLog, 'a-1') >= 1, {
      counts: () => ({ 'a-1': heartbeatCallCount(hbEnv.argsLog, 'a-1') }),
      what: 'waiting for the first loop to start beating',
      intervalSec: HEARTBEAT_INTERVAL_SEC,
      maxMs: 20_000,
    });

    await runHeartbeat(
      [
        'start',
        '--session-pid',
        String(session.pid),
        '--interval',
        String(HEARTBEAT_INTERVAL_SEC),
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
      timeoutMs: 10_000,
      what: 'waiting for the replaced loop to exit',
    });
    await pollUntil(async () => {
      const pid = readPidfile(hbEnv.tmpDir, session.pid);
      if (pid === undefined) {
        return false;
      }
      return isPidAlive(Number.parseInt(pid, 10), hbEnv.env);
    }, { timeoutMs: 10_000, what: 'waiting for the replacing loop to own a live pidfile' });

    const logPath = logfilePath(hbEnv.tmpDir, session.pid);
    await pollUntil(
      () => existsSync(logPath) && readFileSync(logPath, 'utf8').includes('replaced old-loop-pid='),
      { timeoutMs: 10_000, what: 'waiting for the replacement to be logged' },
    );

    await runHeartbeat(['stop', '--session-pid', String(session.pid)], hbEnv);
    activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
  }, 150_000);

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
      what: 'waiting for the loop to register its pidfile',
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
      // 「exits when all ids have dropped」と同じシナリオを /bin/bash 3.2 で回すだけ
      // なので、待ち方も同じ (健全なら only のビートは 1 回、3 は 3 倍の余裕)。
      await pollUntilStopped(
        () =>
          existsSync(logPath)
          && readFileSync(logPath, 'utf8').includes('exit reason=no-ids'),
        {
          extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'only'),
          maxExtraBeats: 3,
          what: 'waiting for the bash 3.2 loop to exit with reason=no-ids',
          maxMs: 20_000,
          diagnose: () => logTail(logPath),
        },
      );
      await pollUntilStopped(() => readPidfile(hbEnv.tmpDir, session.pid) === undefined, {
        extraBeats: () => heartbeatCallCount(hbEnv.argsLog, 'only'),
        maxExtraBeats: 3,
        what: 'waiting for the bash 3.2 loop to remove its pidfile',
        maxMs: 20_000,
        diagnose: () => logTail(logPath),
      });

      activeSessions = activeSessions.filter((s) => s.sessionPid !== session.pid);
    },
    // 予算 (bdboard-69w1): startSession 5s + start 20s + 停止待ち 20s +
    // pidfile 掃除待ち 20s = 最悪 65s < 90s。
    90_000,
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
