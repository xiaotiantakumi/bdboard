import { describe, expect, it } from 'vitest';
import { NodeStreamingCommandRunner } from './node-streaming-command-runner.js';

describe('NodeStreamingCommandRunner', () => {
  const runner = new NodeStreamingCommandRunner();

  /**
   * 子プロセスが自分で書いた pid を読む(bdboard-dvt)。
   *
   * kill 系のテストは「子が pid を書き終える前に kill されない」ことに
   * 暗黙に依存している。そこが崩れたときに `Number('')` = 0 が下流へ流れて
   * 「expected 0 to be greater than 0」や「process 0 is still alive」という
   * 原因の分からない失敗になるので、ここで理由を添えて落とす。
   */
  function parsePid(stdout: string, label: string): number {
    expect(
      stdout,
      `${label}: 子プロセスが pid を書く前に kill された可能性がある(起動が遅い?)`,
    ).not.toBe('');
    const pid = Number(stdout);
    expect(Number.isInteger(pid), `${label}: pid として読めない出力: ${stdout}`).toBe(true);
    expect(pid).toBeGreaterThan(0);
    return pid;
  }

  async function expectProcessToBeGone(pid: number): Promise<void> {
    // pid 0 は「自分のプロセスグループ全体」を指す。signal 0 は配送されない
    // ので実害は無いが、kill が投げないぶん 200ms 待って的外れなメッセージで
    // 落ちるだけになるので、ここで弾く。
    expect(pid, 'pid 0 をプロセス存在確認に渡してはいけない').toBeGreaterThan(0);
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
        // 2回の write の間隔(bdboard-dvt): 親のイベントループがこの間隔より
        // 長く詰まると、両方がパイプに溜まって1チャンクとして読まれ、
        // chunks.length >= 2 が偽になる。負荷の高いマシンでの取りこぼしを
        // 避けるため、ストリーミングを示すのに必要な最小値より広く取る。
        "process.stdout.write('first'); setTimeout(() => process.stdout.write('second'), 100)",
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
      // timeoutMs は run() を呼んだ時点から測り始めるので、この予算は
      // 子プロセスの起動 + pid の write + 親の読み取りを全部含む
      // (bdboard-dvt)。実測では 20ms 前後だが、負荷の高いマシンでは伸びる。
      // このテストの主題は kill の挙動であってタイムアウトの精度ではないので、
      // 予算は余裕を持って取る。
      { timeoutMs: 1_000, onChunk: () => {} },
    );

    expect(result.failureKind).toBe('timeout');
    await expectProcessToBeGone(parsePid(result.stdout, 'timeout'));
  });

  it('terminates the child on abort and waits for it to exit', async () => {
    const controller = new AbortController();
    // 固定待ちで abort すると「子が pid を書く前に abort する」競合が残る
    // (bdboard-dvt)。最初のチャンク = pid が届いたことを合図に abort すれば、
    // 順序が保証されるうえ待ち時間も無くなる。
    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 10_000)'],
      { signal: controller.signal, onChunk: () => controller.abort() },
    );

    expect(result.failureKind).toBe('aborted');
    await expectProcessToBeGone(parsePid(result.stdout, 'abort'));
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
      // タイムアウトで settle してしまうと「バックストップが効いた」のか
      // 「待ちきれずに殺した」のかが区別できない。孫プロセスの寿命(8秒)より
      // 十分長く取り、バックストップだけが settle させ得る状態にする
      // (bdboard-dvt)。
      timeoutMs: 20_000,
      onChunk: (chunk) => chunks.push(chunk.text),
    });
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(0);
    // バックストップは 'exit' から300ms後(delta 再レビュー nit で50ms→300msに
    // 変更)。実測の settle は 320〜330ms 前後。バックストップが壊れると孫が
    // 自然終了する 8 秒まで待つことになるので、その間のどこかに線を引けば
    // 十分に判別できる。負荷の高いマシンでの揺れを吸収するため 3 秒に取る
    // (bdboard-dvt: 1000ms は実測値に対して余裕が 3 倍しかなかった)。
    expect(elapsedMs).toBeLessThan(3_000);

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
      // 予算は子と孫の2プロセス分の起動を含む(bdboard-dvt)。
      timeoutMs: 1_000,
      onChunk: () => {},
    });

    expect(result.failureKind).toBe('timeout');
    const grandchildPid = parsePid(result.stdout.split(':')[0] ?? '', 'group kill / timeout');
    await expectProcessToBeGone(grandchildPid);
  });

  it('kills grandchild processes in the same process group on abort', async () => {
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)']);" +
      "process.stdout.write(String(gc.pid) + ':' + String(process.pid));" +
      'setInterval(() => {}, 10_000);';

    const controller = new AbortController();
    // 固定待ちではなく、pid が届いたことを合図に abort する(bdboard-dvt)。
    const result = await runner.run(process.execPath, ['-e', childScript], {
      signal: controller.signal,
      onChunk: () => controller.abort(),
    });

    expect(result.failureKind).toBe('aborted');
    const grandchildPid = parsePid(result.stdout.split(':')[0] ?? '', 'group kill / abort');
    await expectProcessToBeGone(grandchildPid);
  });
});
