import fs, { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudflaredTunnel,
  resolveDefaultTunnelLogFilePath,
  type LogSink,
} from './cloudflared-tunnel.js';
import { createFakeSpawnedProcess } from './cloudflared-tunnel.test-support.js';

const TUNNEL_URL = 'https://example-abc.trycloudflare.com';

function createFakeLogSink(): LogSink & { readonly lines: string[]; closed: boolean } {
  const sink = {
    lines: [] as string[],
    closed: false,
    write: (chunk: string) => {
      sink.lines.push(chunk);
    },
    close: () => {
      sink.closed = true;
    },
  };
  return sink;
}

describe('createCloudflaredTunnel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports unavailable when cloudflared is not on PATH', async () => {
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => null,
    });

    await expect(tunnel.isAvailable()).resolves.toBe(false);
    await expect(tunnel.start()).rejects.toThrow('cloudflared executable not found');
  });

  // bdboard-syr: 「未インストール」を恒久キャッシュしていたため、後から
  // brew install しても再起動まで拾えなかった。false は毎回引き直す。
  it('re-resolves after an unavailable result so a later install is picked up', async () => {
    let resolved: string | null = null;
    const resolveExecutable = vi.fn(() => resolved);
    const tunnel = createCloudflaredTunnel({ port: 8799, resolveExecutable });

    await expect(tunnel.isAvailable()).resolves.toBe(false);
    await expect(tunnel.isAvailable()).resolves.toBe(false);
    expect(resolveExecutable).toHaveBeenCalledTimes(2);

    resolved = '/usr/bin/cloudflared';
    await expect(tunnel.isAvailable()).resolves.toBe(true);
  });

  it('reflects a cloudflared that disappeared from PATH', async () => {
    let resolved: string | null = '/usr/bin/cloudflared';
    const resolveExecutable = vi.fn(() => resolved);
    const tunnel = createCloudflaredTunnel({ port: 8799, resolveExecutable });

    await expect(tunnel.isAvailable()).resolves.toBe(true);

    // キャッシュを持たない以上、消えたことも見えるのが正しい。
    resolved = null;
    await expect(tunnel.isAvailable()).resolves.toBe(false);
    expect(resolveExecutable).toHaveBeenCalledTimes(2);
  });

  it('resolves cloudflared.exe from a semicolon-delimited win32 PATH', async () => {
    const fake = createFakeSpawnedProcess();
    const accessSync = vi.spyOn(fs, 'accessSync').mockImplementation((candidate) => {
      if (candidate.toString() !== 'C:\\tools\\cloudflared.exe') {
        throw new Error('not found');
      }
    });
    let capturedCommand = '';
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      platform: 'win32',
      pathEnv: 'C:\\missing;C:\\tools',
      spawnFn: (command) => {
        capturedCommand = command;
        return fake;
      },
      createLogSink: () => createFakeLogSink(),
    });

    const startPromise = tunnel.start();

    expect(capturedCommand).toBe('C:\\tools\\cloudflared.exe');
    expect(accessSync.mock.calls.map(([candidate]) => candidate.toString())).toEqual([
      'C:\\missing\\cloudflared.exe',
      'C:\\tools\\cloudflared.exe',
    ]);

    fake.emitStdout(`${TUNNEL_URL}\n`);
    await expect(startPromise).resolves.toEqual({ url: TUNNEL_URL });
  });

  it('does not resolve an extensionless cloudflared entry on win32', async () => {
    const accessSync = vi.spyOn(fs, 'accessSync').mockImplementation((candidate) => {
      if (candidate.toString() !== 'C:\\tools\\cloudflared') {
        throw new Error('not found');
      }
    });
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      platform: 'win32',
      pathEnv: 'C:\\tools',
    });

    await expect(tunnel.isAvailable()).resolves.toBe(false);
    expect(accessSync).toHaveBeenCalledWith('C:\\tools\\cloudflared.exe', fs.constants.X_OK);
  });

  it('keeps resolveExecutable authoritative when platform is win32', async () => {
    const fake = createFakeSpawnedProcess();
    const accessSync = vi.spyOn(fs, 'accessSync');
    let capturedCommand = '';
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      platform: 'win32',
      pathEnv: 'C:\\tools',
      resolveExecutable: () => 'D:\\custom\\cloudflared',
      spawnFn: (command) => {
        capturedCommand = command;
        return fake;
      },
      createLogSink: () => createFakeLogSink(),
    });

    const startPromise = tunnel.start();

    expect(capturedCommand).toBe('D:\\custom\\cloudflared');
    expect(accessSync).not.toHaveBeenCalled();

    fake.emitStdout(`${TUNNEL_URL}\n`);
    await expect(startPromise).resolves.toEqual({ url: TUNNEL_URL });
  });

  it.each(['darwin', 'linux'] as const)(
    'keeps POSIX PATH resolution for %s',
    async (platform) => {
      const accessSync = vi.spyOn(fs, 'accessSync').mockImplementation((candidate) => {
        if (candidate.toString() !== '/tools/cloudflared') {
          throw new Error('not found');
        }
      });
      const tunnel = createCloudflaredTunnel({
        port: 8799,
        platform,
        pathEnv: '/missing:/tools',
      });

      await expect(tunnel.isAvailable()).resolves.toBe(true);
      expect(accessSync.mock.calls.map(([candidate]) => candidate.toString())).toEqual([
        '/missing/cloudflared',
        '/tools/cloudflared',
      ]);
    },
  );

  it('extracts URL from stdout', async () => {
    const fake = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`prefix ${TUNNEL_URL} suffix\n`);
    await expect(startPromise).resolves.toEqual({ url: TUNNEL_URL });
  });

  it('extracts URL split across stdout chunks', async () => {
    const fake = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
    });

    const startPromise = tunnel.start();
    fake.emitStdout('https://exam');
    fake.emitStdout('ple-abc.trycloudflare.com\n');
    await expect(startPromise).resolves.toEqual({ url: TUNNEL_URL });
  });

  it('extracts URL from stderr', async () => {
    const fake = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
    });

    const startPromise = tunnel.start();
    fake.emitStderr(`${TUNNEL_URL}\n`);
    await expect(startPromise).resolves.toEqual({ url: TUNNEL_URL });
  });

  it('fails on timeout when URL never appears', async () => {
    vi.useFakeTimers();
    const fake = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
      startTimeoutMs: 1000,
      stopGraceMs: 100,
    });

    const startPromise = tunnel.start();
    await vi.advanceTimersByTimeAsync(0);
    const expectation = expect(startPromise).rejects.toThrow(
      'timed out waiting for cloudflared tunnel URL',
    );

    await vi.advanceTimersByTimeAsync(2000);
    await expectation;
  });

  it('sends SIGTERM then SIGKILL on stop', async () => {
    vi.useFakeTimers();
    const killSignals: Array<NodeJS.Signals | undefined> = [];
    const fake = createFakeSpawnedProcess({
      onKill: (signal) => {
        killSignals.push(signal);
      },
    });

    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
      stopGraceMs: 500,
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;

    const stopPromise = tunnel.stop();
    expect(killSignals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(500);
    await stopPromise;

    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stop is idempotent when no process is running', async () => {
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => createFakeSpawnedProcess(),
    });

    await expect(tunnel.stop()).resolves.toBeUndefined();
    await expect(tunnel.stop()).resolves.toBeUndefined();
  });

  it('passes the local server URL to cloudflared', async () => {
    const fake = createFakeSpawnedProcess();
    let capturedArgs: readonly string[] = [];

    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: (_cmd, args) => {
        capturedArgs = args;
        return fake;
      },
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await startPromise;

    expect(capturedArgs).toEqual(['tunnel', '--url', 'http://127.0.0.1:8799']);
  });

  it('notifies onUnexpectedExit when the process closes after a successful start without stop() being called', async () => {
    const fake = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
      createLogSink: () => createFakeLogSink(),
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await startPromise;

    const unexpectedExit = vi.fn();
    tunnel.onUnexpectedExit?.(unexpectedExit);

    fake.emitClose(1);

    expect(unexpectedExit).toHaveBeenCalledOnce();
  });

  it('does not notify onUnexpectedExit when stop() was called deliberately', async () => {
    vi.useFakeTimers();
    const fake = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
      stopGraceMs: 500,
      createLogSink: () => createFakeLogSink(),
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;

    const unexpectedExit = vi.fn();
    tunnel.onUnexpectedExit?.(unexpectedExit);

    const stopPromise = tunnel.stop();
    fake.emitClose(0);
    await vi.advanceTimersByTimeAsync(0);
    await stopPromise;

    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  it('does not notify onUnexpectedExit for a stale process replaced by a new start()', async () => {
    const firstFake = createFakeSpawnedProcess();
    const secondFake = createFakeSpawnedProcess();
    let callCount = 0;
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => {
        callCount += 1;
        return callCount === 1 ? firstFake : secondFake;
      },
      createLogSink: () => createFakeLogSink(),
    });

    const firstStart = tunnel.start();
    firstFake.emitStdout(`${TUNNEL_URL}\n`);
    await firstStart;

    const unexpectedExit = vi.fn();
    tunnel.onUnexpectedExit?.(unexpectedExit);

    // A second start() supersedes the first (stopExistingSynchronously clears `child`
    // before the first process's close event ever fires).
    const secondStart = tunnel.start();
    secondFake.emitStdout(`${TUNNEL_URL}\n`);
    await secondStart;

    firstFake.emitClose(0);

    expect(unexpectedExit).not.toHaveBeenCalled();
  });

  it('writes continuous output to the log sink and closes it when the process exits', async () => {
    const fake = createFakeSpawnedProcess();
    const sink = createFakeLogSink();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
      createLogSink: () => sink,
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await startPromise;

    fake.emitStdout('connection registered\n');
    fake.emitClose(0);

    const combined = sink.lines.join('');
    expect(combined).toContain(TUNNEL_URL);
    expect(combined).toContain('connection registered');
    expect(combined).toContain('cloudflared exited');
    expect(sink.closed).toBe(true);
  });

  it('masks secret-like tokens before writing to the log sink', async () => {
    const fake = createFakeSpawnedProcess();
    const sink = createFakeLogSink();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/bin/cloudflared',
      spawnFn: () => fake,
      createLogSink: () => sink,
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await startPromise;

    fake.emitStdout('debug: password=wagon-ivory-65 token: abc123\n');
    fake.emitClose(0);

    const combined = sink.lines.join('');
    expect(combined).not.toContain('wagon-ivory-65');
    expect(combined).not.toContain('abc123');
    expect(combined).toContain('password= ***');
    expect(combined).toContain('token: ***');
  });

  it('passes a real file-backed log sink by default (smoke test via createLogSink override point)', () => {
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => null,
    });

    // No behavioral assertion beyond "constructing without a createLogSink override
    // does not throw" — the default createFileLogSink is exercised for real in
    // main.ts at runtime, not in this unit test suite.
    expect(tunnel).toBeDefined();
  });

  describe('log file rotation (real filesystem, using the default file-backed sink)', () => {
    let tmpDir: string;
    let logFilePath: string;

    function makeTunnel(logMaxBytes: number) {
      const fake = createFakeSpawnedProcess();
      const tunnel = createCloudflaredTunnel({
        port: 8799,
        resolveExecutable: () => '/usr/bin/cloudflared',
        spawnFn: () => fake,
        logFilePath,
        logMaxBytes,
      });
      return { fake, tunnel };
    }

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('rotates .log to .log.1 and starts a fresh file when the size limit is exceeded', async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'cloudflared-tunnel-test-'));
      logFilePath = path.join(tmpDir, 'cloudflared-tunnel.log');
      const oldContent = 'x'.repeat(200);
      writeFileSync(logFilePath, oldContent);

      const { fake, tunnel } = makeTunnel(100);
      const startPromise = tunnel.start();
      fake.emitStdout(`${TUNNEL_URL}\n`);
      await startPromise;

      const rotatedPath = `${logFilePath}.1`;
      expect(existsSync(rotatedPath)).toBe(true);
      expect(readFileSync(rotatedPath, 'utf8')).toBe(oldContent);

      const newContent = readFileSync(logFilePath, 'utf8');
      expect(newContent).not.toContain(oldContent);
      expect(newContent).toContain(TUNNEL_URL);
    });

    it('does not rotate when the existing file is under the size limit', async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'cloudflared-tunnel-test-'));
      logFilePath = path.join(tmpDir, 'cloudflared-tunnel.log');
      const oldContent = 'small\n';
      writeFileSync(logFilePath, oldContent);

      const { fake, tunnel } = makeTunnel(1024 * 1024);
      const startPromise = tunnel.start();
      fake.emitStdout(`${TUNNEL_URL}\n`);
      await startPromise;

      expect(existsSync(`${logFilePath}.1`)).toBe(false);
      const content = readFileSync(logFilePath, 'utf8');
      expect(content).toContain(oldContent.trim());
      expect(content).toContain(TUNNEL_URL);
    });

    it('overwrites an existing .log.1 when rotating again', async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'cloudflared-tunnel-test-'));
      logFilePath = path.join(tmpDir, 'cloudflared-tunnel.log');
      const staleRotated = 'stale-previous-generation';
      const oldContent = 'y'.repeat(200);
      writeFileSync(`${logFilePath}.1`, staleRotated);
      writeFileSync(logFilePath, oldContent);

      const { fake, tunnel } = makeTunnel(100);
      const startPromise = tunnel.start();
      fake.emitStdout(`${TUNNEL_URL}\n`);
      await startPromise;

      const rotatedContent = readFileSync(`${logFilePath}.1`, 'utf8');
      expect(rotatedContent).toBe(oldContent);
      expect(rotatedContent).not.toContain(staleRotated);
    });
  });
});

/** child が parent 配下かどうか。Windows で cwd とホームがドライブをまたぐ
 *  ケース (D:\a\... と C:\Users\...) があるので、relative の結果が絶対パスに
 *  なる場合も「配下ではない」として扱う。 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

describe('log sink creation failure (bdboard-nte)', () => {
  // 既存の restoreAllMocks は describe('createCloudflaredTunnel') スコープなので
  // ここには及ばない。付けないと console.error のモックがファイル末尾まで残り、
  // 後続 describe の診断出力が黙殺される (PR#113 fable レビュー minor)。
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ログ書き込みの失敗は既に「トンネル動作を阻害しない」設計 (write/close/
  // ローテーションはいずれも握り潰す) なのに、シンクの生成だけがその方針から
  // 外れて start() を巻き込んでいた。しかも spawn の後に呼ばれるので、
  // cloudflared の子プロセスを起動した後で例外が飛んでいた。
  function startWithFailingSink() {
    const fake = createFakeSpawnedProcess();
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/local/bin/cloudflared',
      spawnFn: () => fake,
      logFilePath: path.join(tmpdir(), 'bdboard-nte', 'cloudflared-tunnel.log'),
      createLogSink: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    return { fake, tunnel };
  }

  it('still starts the tunnel when the log sink cannot be created', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fake, tunnel } = startWithFailingSink();

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);

    await expect(startPromise).resolves.toEqual({ url: TUNNEL_URL });
  });

  it('reports the failure once, naming the path and the reason', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fake, tunnel } = startWithFailingSink();

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await startPromise;

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0]);
    // 黙って握り潰すのではなく、なぜログが無いのかを1回だけ知らせる。
    expect(message).toContain('cloudflared-tunnel.log');
    expect(message).toContain('EACCES: permission denied');
  });

  it('keeps working after start: output handling does not throw without a sink', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fake, tunnel } = startWithFailingSink();

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await startPromise;

    // no-op シンクに差し替わっているので、以降の出力も stop も素通りする。
    expect(() => fake.emitStdout('more output\n')).not.toThrow();
    expect(() => fake.emitStderr('a warning\n')).not.toThrow();

    const stopPromise = tunnel.stop();
    fake.emitClose(0);
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it('retries sink creation on the next start instead of falling back forever', async () => {
    // フォールバックは恒久ではなく start ごとの判断。シンクをファクトリ外に
    // キャッシュするリファクタが入ると、FS の問題が直ってもログが戻らなくなる
    // (PR#113 fable レビュー nit)。
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const written: string[] = [];
    let attempt = 0;
    let spawned = 0;
    const fakes = [createFakeSpawnedProcess(), createFakeSpawnedProcess()];
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/local/bin/cloudflared',
      // シンク生成は spawn の後なので、spawn 側は独自にカウントする。
      spawnFn: () => {
        spawned += 1;
        return fakes[spawned - 1] as ReturnType<typeof createFakeSpawnedProcess>;
      },
      logFilePath: path.join(tmpdir(), 'bdboard-nte', 'cloudflared-tunnel.log'),
      createLogSink: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error('EACCES: permission denied');
        }
        return {
          write: (chunk: string) => written.push(chunk),
          close: () => {},
        };
      },
    });

    const firstStart = tunnel.start();
    fakes[0]?.emitStdout(`${TUNNEL_URL}\n`);
    await firstStart;
    fakes[0]?.emitStdout('lost to the failed sink\n');
    expect(written).toEqual([]);

    const firstStop = tunnel.stop();
    fakes[0]?.emitClose(0);
    await firstStop;

    const secondStart = tunnel.start();
    fakes[1]?.emitStdout(`${TUNNEL_URL}\n`);
    await secondStart;

    expect(attempt).toBe(2);
    expect(written.join('')).toContain(TUNNEL_URL);
  });
});

describe('default log path wiring', () => {
  // 上の describe は解決関数そのものしか見ていない。関数が正しくても
  // createCloudflaredTunnel 側の fallback を cwd 基準に書き戻せばバグは再発するので、
  // 「logFilePath 未指定なら既定の解決関数の結果が使われる」も固定する
  // (PR#111 fable レビュー minor-2)。
  it('passes resolveDefaultTunnelLogFilePath() to the sink when logFilePath is omitted', async () => {
    const fake = createFakeSpawnedProcess();
    const seen: string[] = [];
    const tunnel = createCloudflaredTunnel({
      port: 8799,
      resolveExecutable: () => '/usr/local/bin/cloudflared',
      spawnFn: () => fake,
      createLogSink: (filePath) => {
        seen.push(filePath);
        return createFakeLogSink();
      },
    });

    const startPromise = tunnel.start();
    fake.emitStdout(`${TUNNEL_URL}\n`);
    await startPromise;

    expect(seen).toEqual([resolveDefaultTunnelLogFilePath()]);
  });
});

describe('resolveDefaultTunnelLogFilePath', () => {
  // 既定パスが process.cwd() 基準だった頃の問題 (bdboard-3b0): npx bdboard は
  // 任意の cwd から起動されるので、トンネルを開いた瞬間にユーザーがたまたま
  // 居たディレクトリへ logs/ を掘っていた。
  it('resolves under the home directory, next to the cache db', () => {
    const home = path.join(tmpdir(), 'bdboard-home');

    expect(resolveDefaultTunnelLogFilePath({ homedir: home })).toBe(
      path.join(home, '.bdboard', 'logs', 'cloudflared-tunnel.log'),
    );
  });

  it('does not depend on the process cwd', () => {
    // 上のテストは homedir を注入しているので、実装が opts を無視して cwd を
    // 見ていても「たまたま」通る可能性は無い — が、注入なしの実運用パスでも
    // cwd 配下に落ちないことを直接固定しておく。
    const resolved = resolveDefaultTunnelLogFilePath();

    expect(resolved).toBe(
      path.join(homedir(), '.bdboard', 'logs', 'cloudflared-tunnel.log'),
    );
    // 前提: リポジトリルートから走らせること。ホームそのものを cwd にすると
    // ~/.bdboard は cwd 配下になるので、実装が正しくてもここは落ちる。
    expect(isInside(process.cwd(), resolved)).toBe(false);
  });
});
