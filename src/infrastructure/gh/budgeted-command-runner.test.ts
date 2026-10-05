import { describe, expect, it, vi } from 'vitest';
import { createSlidingWindowBudget } from '../../application/issue-report/call-budget.js';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createBudgetedCommandRunner } from './budgeted-command-runner.js';
import { createGhCliExternalIssueSource } from './gh-cli-external-issue-source.js';

const EXHAUSTED = 'gh call limit reached: at most 12 gh calls per hour (local limit); try again later';

function createInner(result: CommandResult = { stdout: 'inner output', stderr: '', exitCode: 0 }) {
  const run = vi.fn<CommandRunner['run']>(() => Promise.resolve(result));
  return { inner: { run } satisfies CommandRunner, run };
}

function budgetOf(limit: number) {
  let nowMs = 0;
  return {
    budget: createSlidingWindowBudget({ limit, windowMs: 3_600_000, now: () => nowMs }),
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe('createBudgetedCommandRunner', () => {
  it('passes the command, the arguments, the options and the result through while the budget lasts', async () => {
    const innerResult: CommandResult = { stdout: 'out', stderr: 'err', exitCode: 3, failureKind: 'timeout' };
    const { inner, run } = createInner(innerResult);
    const { budget } = budgetOf(2);
    const runner = createBudgetedCommandRunner(inner, budget, EXHAUSTED);
    const options = { timeoutMs: 20_000, env: { GH_PROMPT_DISABLED: '1' } };

    const result = await runner.run('gh', ['api', 'x'], options);

    expect(result).toBe(innerResult);
    expect(run).toHaveBeenCalledExactlyOnceWith('gh', ['api', 'x'], options);
  });

  it('does not start the command once the budget is used up, and returns a failed result that says why', async () => {
    const { inner, run } = createInner();
    const { budget } = budgetOf(2);
    const runner = createBudgetedCommandRunner(inner, budget, EXHAUSTED);

    await runner.run('gh', ['one']);
    await runner.run('gh', ['two']);
    const refused = await runner.run('gh', ['three']);

    expect(run).toHaveBeenCalledTimes(2);
    expect(refused).toEqual({ stdout: '', stderr: EXHAUSTED, exitCode: 1 });
    // 何度頼んでも、起動は増えない。
    await runner.run('gh', ['four']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('starts commands again once the window has passed', async () => {
    const { inner, run } = createInner();
    const { budget, advance } = budgetOf(1);
    const runner = createBudgetedCommandRunner(inner, budget, EXHAUSTED);

    await runner.run('gh', ['first']);
    expect((await runner.run('gh', ['second'])).stderr).toBe(EXHAUSTED);
    advance(3_600_000);
    await runner.run('gh', ['third']);

    expect(run.mock.calls.map(([, args]) => args)).toEqual([['first'], ['third']]);
  });

  it('propagates a rejection from the inner runner and still counts that call', async () => {
    const run = vi.fn<CommandRunner['run']>(() => Promise.reject(new Error('boom')));
    const { budget } = budgetOf(1);
    const runner = createBudgetedCommandRunner({ run }, budget, EXHAUSTED);

    await expect(runner.run('gh', [])).rejects.toThrow('boom');
    expect((await runner.run('gh', [])).stderr).toBe(EXHAUSTED);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses exactly one unit of the budget for each run call', async () => {
    const { inner } = createInner();
    const { budget } = budgetOf(5);
    const runner = createBudgetedCommandRunner(inner, budget, EXHAUSTED);

    await runner.run('gh', []);
    await runner.run('gh', []);

    expect(budget.used()).toBe(2);
  });
});

describe('createBudgetedCommandRunner in front of the gh source for incoming issues', () => {
  /** 100 行ちょうどのページ (次のページがありうる)。 */
  const fullPage = `${Array.from({ length: 100 }, (_, index) =>
    JSON.stringify({
      number: index + 1,
      title: `issue ${index + 1}`,
      body: 'b',
      bodyLength: 1,
      updatedAt: '2026-10-05T00:00:00Z',
      author: 'someone',
      authorAssociation: 'NONE',
      pullRequest: false,
    }),
  ).join('\n')}\n`;

  it('reports an exhausted budget as a plain failed result, not as rate-limited, unauthenticated or missing', async () => {
    const { inner, run } = createInner({ stdout: fullPage, stderr: '', exitCode: 0 });
    const { budget } = budgetOf(3);
    const source = createGhCliExternalIssueSource(createBudgetedCommandRunner(inner, budget, EXHAUSTED));

    // 3 ページとも 100 行なので、1 回の確認が枠を 3 回使い切る。
    const first = await source.listOpenIssues();
    expect(first).toMatchObject({ ok: true, pagesFetched: 3, truncatedByPageLimit: true });
    expect(run).toHaveBeenCalledTimes(3);

    const second = await source.listOpenIssues();
    expect(second).toEqual({ ok: false, kind: 'failed', detail: EXHAUSTED });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('turns a check that runs out of budget half way into a failure with no partial list', async () => {
    const { inner, run } = createInner({ stdout: fullPage, stderr: '', exitCode: 0 });
    const { budget } = budgetOf(2);
    const source = createGhCliExternalIssueSource(createBudgetedCommandRunner(inner, budget, EXHAUSTED));

    const result = await source.listOpenIssues();

    // 1 回の確認の途中 (3 ページ目の手前) で枠が切れたら、途中までの結果は返さない (9.2 の「1 ページでも読めなければ failed」)。
    expect(result).toEqual({ ok: false, kind: 'failed', detail: EXHAUSTED });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
