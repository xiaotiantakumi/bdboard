/**
 * bdboard-o1e5: 「いま画面に出ているプロジェクト」をクライアントからの申告で持つ
 * インメモリのレジストリ。クライアント (タブ) ごとに最新の申告を TTL つきで保持し、
 * 有効な申告すべての和集合を「表示中のプロジェクト」とする。
 *
 * 用途は2つだけ: (1) 停止した Dolt サーバーの `dolt start` を表示中のプロジェクトに
 * 限る、(2) /api/status のエラーを表示中のプロジェクト分に絞る。全プロジェクトの
 * 読み取りリフレッシュ自体はこのレジストリに影響されない。
 */
export const DEFAULT_VISIBLE_PROJECTS_TTL_MS = 5 * 60_000;

export interface VisibleProjectsRegistry {
  /** clientId の申告を置き換える。戻り値は、この申告で新たに表示中になったプロジェクト ID。 */
  report(clientId: string, projectIds: readonly string[]): readonly string[];
  /** 有効な申告すべての和集合。 */
  visibleIds(): ReadonlySet<string>;
  /** 有効な申告が1件でもあるか。 */
  hasReports(): boolean;
  isVisible(projectId: string): boolean;
}

export function createVisibleProjectsRegistry(
  options: { readonly now?: () => number; readonly ttlMs?: number } = {},
): VisibleProjectsRegistry {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_VISIBLE_PROJECTS_TTL_MS;
  const entries = new Map<string, { ids: ReadonlySet<string>; expiresAt: number }>();

  function prune(): void {
    const t = now();
    for (const [clientId, entry] of entries) {
      if (entry.expiresAt <= t) {
        entries.delete(clientId);
      }
    }
  }

  function union(): Set<string> {
    prune();
    const out = new Set<string>();
    for (const entry of entries.values()) {
      for (const id of entry.ids) {
        out.add(id);
      }
    }
    return out;
  }

  return {
    report(clientId, projectIds) {
      const before = union();
      entries.set(clientId, {
        ids: new Set(projectIds),
        expiresAt: now() + ttlMs,
      });
      const added: string[] = [];
      for (const id of new Set(projectIds)) {
        if (!before.has(id)) {
          added.push(id);
        }
      }
      return added;
    },
    visibleIds: union,
    hasReports() {
      prune();
      return entries.size > 0;
    },
    isVisible(projectId) {
      return union().has(projectId);
    },
  };
}
