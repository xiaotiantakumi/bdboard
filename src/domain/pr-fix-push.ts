/**
 * 「修正 push 回数」(bdboard-p5l.27)。
 *
 * 定義 (議長がユーザー承認のもとで決定): **PR 作成 (createdAt) より後にコミットされた
 * コミットの数** = `gh pr view <N> --json commits,createdAt` の commits のうち
 * `committedDate > createdAt` の件数。CI 実行回数 (`gh run list`) は採らない。
 *
 * 制約 (集計の読み方として知っておくこと):
 * - 実際の push 回数ではなくコミット数なので、1 回の push に複数コミットが含まれていれば
 *   その分だけ数える (手戻りの量の目安として使う)。
 * - rebase / amend は committedDate を更新するので、PR 作成後に `git rebase` した場合は
 *   中身が同じコミットも「作成後にコミットされた」と数えて多めに出る。
 * - gh の `commits` は GitHub 側の上限 (約 100 件) で切られることがある。
 */

export interface PrCommitDateLike {
  readonly committedDate?: string | null | undefined;
}

function parseInstantMs(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * PR 作成後にコミットされたコミット数を返す。
 *
 * createdAt / commits が欠けている・createdAt が日時として読めないときは、0 と区別
 * できるよう undefined (= 不明) を返す。committedDate が読めないコミットは数えない
 * (その場合、返す値は下限になる)。
 */
export function countPostCreateCommits(
  createdAt: string | null | undefined,
  commits: readonly PrCommitDateLike[] | null | undefined,
): number | undefined {
  const createdAtMs = parseInstantMs(createdAt);
  if (createdAtMs === undefined || commits === undefined || commits === null) {
    return undefined;
  }
  let count = 0;
  for (const commit of commits) {
    const committedAtMs = parseInstantMs(commit.committedDate);
    if (committedAtMs !== undefined && committedAtMs > createdAtMs) {
      count += 1;
    }
  }
  return count;
}
