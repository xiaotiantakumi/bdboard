import { describe, expect, it } from 'vitest';
import { NodeCommandRunner } from './node-command-runner.js';

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
});
