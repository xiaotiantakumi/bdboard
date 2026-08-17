import { describe, expect, it } from 'vitest';
import { NodeStreamingCommandRunner } from './node-streaming-command-runner.js';

describe('NodeStreamingCommandRunner', () => {
  const runner = new NodeStreamingCommandRunner();

  async function expectProcessToBeGone(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`child process ${pid} is still alive`);
  }

  it('delivers stdout chunks in order and retains the complete output', async () => {
    const chunks: string[] = [];
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 30)",
      ],
      { onChunk: (chunk) => chunks.push(chunk.text) },
    );

    expect(result.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('')).toBe('firstsecond');
    expect(result.stdout).toBe(chunks.join(''));
  });

  it('writes input to child stdin', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', "process.stdout.write(require('fs').readFileSync(0, 'utf8'))"],
      { input: 'hello-from-stdin', onChunk: () => {} },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-from-stdin');
  });

  it('replaces env without inheriting the parent environment', async () => {
    const previous = process.env.BDBOARD_STREAMING_TEST_VAR;
    process.env.BDBOARD_STREAMING_TEST_VAR = 'from-parent';

    try {
      const result = await runner.run(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.BDBOARD_STREAMING_TEST_VAR ?? "missing"))'],
        { env: {}, onChunk: () => {} },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('missing');
    } finally {
      if (previous === undefined) {
        delete process.env.BDBOARD_STREAMING_TEST_VAR;
      } else {
        process.env.BDBOARD_STREAMING_TEST_VAR = previous;
      }
    }
  });

  it('terminates the child on timeout and waits for it to exit', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 10_000)'],
      { timeoutMs: 200, onChunk: () => {} },
    );

    expect(result.failureKind).toBe('timeout');
    const pid = Number(result.stdout);
    await expectProcessToBeGone(pid);
  });

  it('terminates the child on abort and waits for it to exit', async () => {
    const controller = new AbortController();
    const resultPromise = runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 10_000)'],
      { signal: controller.signal, onChunk: () => {} },
    );
    setTimeout(() => controller.abort(), 200);

    const result = await resultPromise;
    expect(result.failureKind).toBe('aborted');
    const pid = Number(result.stdout);
    await expectProcessToBeGone(pid);
  });

  it('returns spawn-failed for a missing binary without throwing', async () => {
    const result = await runner.run('/no/such/binary-ever', ['--version'], {
      onChunk: () => {},
    });

    expect(result.exitCode).toBe(-1);
    expect(result.failureKind).toBe('spawn-failed');
  });

  // bdboard-l1t.9 Opus レビュー M1: 直接の子が exit しても、孫プロセスが
  // stdout/stderr のパイプ fd を継承したまま生きていると Node の 'close' が
  // 永久に来ず run() が settle しない(=呼び出し元の busy lock がサーバー再起動
  // まで解放されない)。既存の timeout/abort テストは孫プロセスを作らないので
  // このバグを検知できなかった。ここでは孫プロセス(inherit stdio, detached)を
  // 明示的に作って再現する。
  it('settles quickly even when a grandchild process keeps the stdio pipes open after the child exits', async () => {
    // bdboard-l1t.9 delta 再レビュー nit: 孫プロセスは PID 捕捉に失敗しても
    // 永久リークしないよう、setInterval(無限ループ)ではなく自己終了する
    // setTimeout(8000ms 後に自然終了)にしておく。テスト内の SIGKILL 後始末が
    // 何らかの理由で走らなくても、この孫プロセスは自分で片付く。
    const grandchildScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });" +
      'gc.unref();' +
      'process.exit(0);';

    const chunks: string[] = [];
    const start = Date.now();
    const result = await runner.run(process.execPath, ['-e', grandchildScript], {
      timeoutMs: 5_000,
      onChunk: (chunk) => chunks.push(chunk.text),
    });
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(0);
    // バックストップは 'exit' から300ms後(delta 再レビュー nit で50ms→300msに
    // 変更)。孫プロセスの存在に関わらず、タイムアウト(5000ms)よりずっと早く
    // settle するはず。
    expect(elapsedMs).toBeLessThan(1_000);

    const grandchildPid = Number(chunks.join(''));
    if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // すでに居なければ何もしない(ベストエフォートな後始末)。
      }
    }
  });

  it('kills grandchild processes in the same process group on timeout', async () => {
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)']);" +
      "process.stdout.write(String(gc.pid) + ':' + String(process.pid));" +
      'setInterval(() => {}, 10_000);';

    const result = await runner.run(process.execPath, ['-e', childScript], {
      timeoutMs: 200,
      onChunk: () => {},
    });

    expect(result.failureKind).toBe('timeout');
    const grandchildPid = Number(result.stdout.split(':')[0]);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(grandchildPid).toBeGreaterThan(0);
    await expectProcessToBeGone(grandchildPid);
  });

  it('kills grandchild processes in the same process group on abort', async () => {
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)']);" +
      "process.stdout.write(String(gc.pid) + ':' + String(process.pid));" +
      'setInterval(() => {}, 10_000);';

    const controller = new AbortController();
    const resultPromise = runner.run(process.execPath, ['-e', childScript], {
      signal: controller.signal,
      onChunk: () => {},
    });
    setTimeout(() => controller.abort(), 200);

    const result = await resultPromise;
    expect(result.failureKind).toBe('aborted');
    const grandchildPid = Number(result.stdout.split(':')[0]);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(grandchildPid).toBeGreaterThan(0);
    await expectProcessToBeGone(grandchildPid);
  });
});
