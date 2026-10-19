export interface StatusErrorEntry {
  readonly kind: string;
  readonly projectId: string;
  readonly detail: string;
}

/**
 * bdboard-o1e5: リフレッシュ結果から /api/status 用のエラー一覧を作る。
 * 全体リフレッシュ (onlyProjectIds 未指定) は従来どおり結果のエラーで丸ごと置き換える。
 * 一部のプロジェクトだけのリフレッシュ (onlyProjectIds 指定) は対象外のプロジェクトを
 * 調べていないので、それらの既存エラーは残し、対象のプロジェクトの分だけ入れ替える
 * (そうしないと 1 件の部分更新で他プロジェクトの未解決エラーが消えてしまう)。
 * discovery から消えたプロジェクトのエラーは落とす。
 */
export function mergeStatusErrors(
  previous: readonly StatusErrorEntry[],
  resultErrors: readonly StatusErrorEntry[],
  removed: readonly string[],
  onlyProjectIds: readonly string[] | undefined,
): StatusErrorEntry[] {
  const fresh = resultErrors.map((e) => ({
    kind: e.kind,
    projectId: e.projectId,
    detail: e.detail,
  }));
  if (onlyProjectIds === undefined) {
    return fresh;
  }
  const refreshedScope = new Set(onlyProjectIds);
  const gone = new Set(removed);
  const kept = previous.filter(
    (e) => !refreshedScope.has(e.projectId) && !gone.has(e.projectId),
  );
  return [...kept, ...fresh];
}
