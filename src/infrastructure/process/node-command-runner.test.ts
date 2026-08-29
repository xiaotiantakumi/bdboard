import { describe, expect, it } from 'vitest';
import { NodeCommandRunner } from './node-command-runner.js';

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

describe('NodeCommandRunner', () => {
  const runner = new NodeCommandRunner();

  it('writes input to child stdin', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', "process.stdout.write(require('fs').readFileSync(0, 'utf8'))"],
      { input: 'hello-from-stdin' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-from-stdin');
  });

  it('closes stdin immediately when input is omitted so stdin-waiting children do not hang', async () => {
    const childScript =
      "let data='';" +
      "process.stdin.on('data', (chunk) => { data += chunk; });" +
      "process.stdin.on('end', () => { process.stdout.write('done:' + data); });";

    const start = Date.now();
    const result = await runner.run(process.execPath, ['-e', childScript], {
      timeoutMs: 2_000,
    });
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done:');
    expect(result.failureKind).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('does not crash when the child exits before draining stdin', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', 'process.exit(0)'],
      { input: 'x'.repeat(5_000_000) },
    );

    expect(result.exitCode).toBe(0);
  });

  it('replaces env when env option is provided', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.BDBOARD_TEST_VAR))'],
      { env: { BDBOARD_TEST_VAR: 'replacement-only' } },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('replacement-only');
  });

  it('does not inherit process env when env option is provided', async () => {
    const previous = process.env.BDBOARD_TEST_VAR;
    process.env.BDBOARD_TEST_VAR = 'from-parent';

    try {
      const result = await runner.run(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.BDBOARD_TEST_VAR ?? "missing"))'],
        { env: {} },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('missing');
    } finally {
      if (previous === undefined) {
        delete process.env.BDBOARD_TEST_VAR;
      } else {
        process.env.BDBOARD_TEST_VAR = previous;
      }
    }
  });

  it('returns failureKind spawn-failed for a missing binary', async () => {
    const result = await runner.run('/no/such/binary-ever', ['--version']);

    expect(result.exitCode).toBe(-1);
    expect(result.failureKind).toBe('spawn-failed');
  });

  // 実プロセスで打ち切る。timeout の検出は execFile が立てる killed フラグに
  // 依存しており、Node の実挙動を突かないと固定できない(bdboard-l1t.8)。
  it('returns failureKind timeout when the child outlives timeoutMs', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      { timeoutMs: 200 },
    );

    expect(result.failureKind).toBe('timeout');
  });

  // 退行防止: 素の非ゼロ終了を timeout に巻き込まないこと。
  it('leaves failureKind unset for a plain non-zero exit', async () => {
    const result = await runner.run(process.execPath, [
      '-e',
      'process.exit(3)',
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.failureKind).toBeUndefined();
  });

  it('kills grandchild processes in the same process group on timeout', async () => {
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)']);" +
      "process.stdout.write(String(gc.pid) + ':' + String(process.pid));" +
      'setInterval(() => {}, 10_000);';

    const result = await runner.run(process.execPath, ['-e', childScript], {
      timeoutMs: 200,
    });

    expect(result.failureKind).toBe('timeout');
    const grandchildPid = Number(result.stdout.split(':')[0]);
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(grandchildPid).toBeGreaterThan(0);
    await expectProcessToBeGone(grandchildPid);
  });
  // bdboard-3x5: streaming 側 (bdboard-l1t.9 M1) が獲得した3点セットが、こちらの
  // ランナーには入っていなかった。このランナーは main.ts の単一インスタンスで
  // bd / gh / git / ps / ai-quota の全 CLI 呼び出しに使われるので、settle しない
  // 経路が1つでも残ると影響が広い。以下2本はどちらも修正前のコードで失敗する
  // ことを確認済み。
  it('escalates to SIGKILL and settles when the child ignores SIGTERM', async () => {
    // SIGTERM をトラップして無視する子。SIGTERM 一発だけの実装では 'close' が
    // 永久に来ず run() が settle しない。SIGKILL はトラップできないので、
    // エスカレーションがあれば必ず終わる。
    const childScript =
      "process.on('SIGTERM', () => {});" +
      "process.stdout.write('ready');" +
      'setInterval(() => {}, 10_000);';

    const start = Date.now();
    const result = await runner.run(process.execPath, ['-e', childScript], {
      timeoutMs: 200,
    });
    const elapsedMs = Date.now() - start;

    expect(result.failureKind).toBe('timeout');
    // 猶予 3000ms + 余裕。8_000 だと vitest 既定の testTimeout 5000ms が先に効いて
    // 死んだ閾値になるので、実効上限より内側に置く (PR#119 fable レビュー nit)。
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it('does not mislabel a successful exit as timeout when a grandchild holds the pipes', async () => {
    // 子は exit 0 で正常終了するが、孫が stdio を継承したまま生きているので
    // 'close' が遅延する。'exit' バックストップが無いと、その遅延中に
    // タイムアウトが発火し、成功が failureKind:'timeout' と誤ラベルされる。
    // reclaim-scheduler は failureKind の有無で失敗判定するため実害がある。
    //
    // 孫は PID 捕捉に失敗しても永久リークしないよう自己終了させる
    // (streaming 側テストと同じ方針)。
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });" +
      'gc.unref();' +
      'process.exit(0);';

    const start = Date.now();
    const result = await runner.run(process.execPath, ['-e', childScript], {
      timeoutMs: 1_000,
    });
    const elapsedMs = Date.now() - start;

    expect(result.exitCode).toBe(0);
    expect(result.failureKind).toBeUndefined();
    expect(elapsedMs).toBeLessThan(1_000);

    const grandchildPid = Number(result.stdout.trim());
    if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // 既に終了していれば何もしなくてよい。
      }
    }
  });
  // 上2本の合成 = 現実的な最悪ケース。SIGTERM を無視する子が、さらに stdio を
  // 継承した孫を残している。SIGKILL で子は死ぬが孫が fd を握り続けるので
  // 'close' は来ない。ここを settle させられるのはパイプの明示破棄だけで、
  // SIGKILL エスカレーションと destroyStdio の両方が要る (bdboard-3x5)。
  it('settles when the child both ignores SIGTERM and leaves a pipe-holding grandchild', async () => {
    const childScript =
      "const { spawn } = require('node:child_process');" +
      "const gc = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });" +
      'gc.unref();' +
      "process.on('SIGTERM', () => {});" +
      'setInterval(() => {}, 10_000);';

    const start = Date.now();
    const result = await runner.run(process.execPath, ['-e', childScript], {
      timeoutMs: 200,
    });
    const elapsedMs = Date.now() - start;

    expect(result.failureKind).toBe('timeout');
    expect(elapsedMs).toBeLessThan(4_000);

    const grandchildPid = Number(result.stdout.trim());
    if (Number.isInteger(grandchildPid) && grandchildPid > 0) {
      try {
        process.kill(grandchildPid, 'SIGKILL');
      } catch {
        // 既に終了していれば何もしなくてよい。
      }
    }
  });
});
