// bdboard-sso1.51: reclaim-scheduler.ts のモジュール分割。reclaim 失敗時の要約文字列
// 組み立てをまとめたモジュール (move only, 挙動変更ゼロ)。create-scheduler.ts からの
// cross-module use のため export を付けている (元は reclaim-scheduler.ts 内の非公開関数。
// 公開エクスポート面には含めない — 入口の reclaim-scheduler.ts はこれらを re-export しない)。

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function summarizeFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
  failureKind?: string,
): string {
  const parts = [
    failureKind !== undefined ? `failure=${failureKind}` : undefined,
    `exit=${exitCode}`,
    stdout.trim().length > 0 ? `stdout=${stdout.trim()}` : undefined,
    stderr.trim().length > 0 ? `stderr=${stderr.trim()}` : undefined,
  ].filter((part) => part !== undefined);
  return parts.join('; ') || `exit code ${exitCode}`;
}
