/**
 * 1 本の非同期処理に締め切りを付ける。scanHarnessWorktreeLags /
 * scanNonTicketHarnessWorktreeLags が同じ理由 (1 worktree の git 呼び出しがハングしても
 * 盤面全体を巻き込まない) で使うため、重複実装を避けてここに集約する (bdboard-wadg。
 * duplicate-helper-parallel の再発防止 — failure-catalog.md 参照)。
 */
export async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${deadlineMs}ms reading ${label}`));
        }, deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
