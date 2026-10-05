import type { SlidingWindowBudget } from '../../application/issue-report/call-budget.js';
import type { CommandRunner } from '../../application/ports/command-runner.js';

/**
 * 呼び出しの回数に上限を付けた CommandRunner (bdboard-4y8q.9.4)。届いた issue の gh の呼び出しを、
 * 「1 時間に 12 回まで」に抑える関所として使う (docs/ISSUE-REPORTING.md 8節)。
 *
 * gh を起動する道を、この 1 つの関所だけにすることで、定期の確認・手動の refresh・ページ送り (1 回の確認で最大 3 ページ)
 * のどの組み合わせでも、起動する回数が上限を超えない。上限に達したら `inner` を呼ばず、gh が失敗したのと同じ形
 * (終了コード 1 と、理由を書いた stderr) の結果を返す: 読み取りの層はこれを `failed` として扱い、例外にも認証無しの経路にも落ちない。
 * `exhaustedMessage` は gh の rate limit や未ログインの文言 (`gh-cli-failure.ts` のパターン) に当たらない文面にすること
 * (当たると、その種類に分類されて理由が見えなくなる)。
 *
 * 回数は `inner.run` を呼ぶ直前に数える。`inner.run` が投げても数えた分は戻さない (呼んだ事実は残る)。
 */
export function createBudgetedCommandRunner(
  inner: CommandRunner,
  budget: Pick<SlidingWindowBudget, 'tryConsume'>,
  exhaustedMessage: string,
): CommandRunner {
  return {
    run(command, args, options) {
      if (!budget.tryConsume()) {
        return Promise.resolve({ stdout: '', stderr: exhaustedMessage, exitCode: 1 });
      }
      return inner.run(command, args, options);
    },
  };
}
