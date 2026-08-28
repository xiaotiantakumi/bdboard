import fs, { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudflaredTunnel, type LogSink } from './cloudflared-tunnel.js';
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
