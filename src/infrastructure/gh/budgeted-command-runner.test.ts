import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../application/ports/command-runner.js';
import { createBudgetedCommandRunner } from './budgeted-command-runner.js';
import { createGhCliExternalIssueSource } from './gh-cli-external-issue-source.js';

describe('budgeted command runner', () => {
  it('passes through the call and result, then rejects without calling inner', async () => {
    const result = { stdout: 'ok', stderr: '', exitCode: 0 };
    const inner: CommandRunner = { run: vi.fn().mockResolvedValue(result) };
    const budget = { tryConsume: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) };
    const runner = createBudgetedCommandRunner(inner, budget, 'local gh call budget exhausted');
    const opts = { timeoutMs: 123 };
    await expect(runner.run('gh', ['api'], opts)).resolves.toBe(result);
    await expect(runner.run('gh', ['api'], opts)).resolves.toEqual({ stdout: '', stderr: 'local gh call budget exhausted', exitCode: 1 });
    expect(inner.run).toHaveBeenCalledTimes(1);
    expect(inner.run).toHaveBeenCalledWith('gh', ['api'], opts);
  });

  it('preserves runner rejections and maps exhaustion through the real gh source', async () => {
    const exhaustedMessage = 'gh call limit reached: local limit, try again later';
    const inner: CommandRunner = { run: vi.fn().mockRejectedValueOnce(new Error('runner failed')) };
    const throwingRunner = createBudgetedCommandRunner(inner, { tryConsume: () => true }, exhaustedMessage);
    await expect(throwingRunner.run('gh', [])).rejects.toThrow('runner failed');
    const gated = createBudgetedCommandRunner({ run: vi.fn() }, { tryConsume: () => false }, exhaustedMessage);
    const source = createGhCliExternalIssueSource(gated, { ghPath: 'gh' });
    await expect(source.listOpenIssues()).resolves.toMatchObject({ ok: false, kind: 'failed', detail: exhaustedMessage });
  });
});
