import type { CommandRunner } from '../../application/ports/command-runner.js';
import type { SlidingWindowBudget } from '../../application/issue-report/call-budget.js';

export function createBudgetedCommandRunner(
  inner: CommandRunner,
  budget: Pick<SlidingWindowBudget, 'tryConsume'>,
  exhaustedMessage: string,
): CommandRunner {
  return {
    run(command, args, options) {
      if (!budget.tryConsume()) return Promise.resolve({ stdout: '', stderr: exhaustedMessage, exitCode: 1 });
      return inner.run(command, args, options);
    },
  };
}
