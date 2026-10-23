/**
 * bdboard-o1e5: 「いま画面に出ているプロジェクト」をクライアントからの申告で持つ
 * インメモリのレジストリ。クライアント (タブ) ごとに最新の申告を TTL つきで保持し、
 * 有効な申告すべての和集合を「表示中のプロジェクト」とする。
 *
 * 申告は ID の一覧か、全プロジェクト表示 (選択が空) を表すワイルドカード (`all`)。
 * ワイルドカードが1件でも有効なら、すべてのプロジェクトが表示中として扱われる
 * (まだキャッシュに無いプロジェクトも含む)。
 *
 * 用途は2つだけ: (1) 停止した Dolt サーバーの `dolt start` を表示中のプロジェクトに
 * 限る、(2) /api/status のエラーを表示中のプロジェクト分に絞る。全プロジェクトの
 * 読み取りリフレッシュ自体はこのレジストリに影響されない。
 */
export const DEFAULT_VISIBLE_PROJECTS_TTL_MS = 5 * 60_000;
/** 保持するクライアント数の上限。超えたら最も古い申告から捨てる。 */
export const MAX_VISIBLE_PROJECTS_CLIENTS = 32;

export type VisibleProjectsReport =
  | { readonly all: true }
  | { readonly projectIds: readonly string[] };

export interface VisibleProjectsSnapshot {
  readonly hasReports: boolean;
  isVisible(projectId: string): boolean;
}

export interface VisibleProjectsRegistry extends VisibleProjectsSnapshot {
  /** clientId の申告を置き換える。戻り値は、この申告で新たに表示中になったプロジェクト ID (ワイルドカードは含まない)。 */
  report(clientId: string, report: VisibleProjectsReport): readonly string[];
  /** 有効な申告のある時点のスナップショット (1リクエストで繰り返し判定するとき用)。 */
  snapshot(): VisibleProjectsSnapshot;
  /**
   * bdboard-u8p9: ローカル (非トンネル) クライアントが最後に申告した選択を覚える。スマホが
   * トンネル経由で初めて開いたとき PC と同じ選択で始めるための読み取り専用の材料。
   * 空配列 = 全プロジェクト表示。TTL は掛けない (PC のタブを閉じた後も直近の選択を返す)。
   */
  rememberLocalSelection(projectIds: readonly string[]): void;
  /** 一度も申告が無ければ null。 */
  getLocalSelection(): readonly string[] | null;
}

interface Entry {
  readonly all: boolean;
  readonly ids: ReadonlySet<string>;
  readonly expiresAt: number;
}

export function createVisibleProjectsRegistry(
  options: {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly maxClients?: number;
  } = {},
): VisibleProjectsRegistry {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_VISIBLE_PROJECTS_TTL_MS;
  const maxClients = options.maxClients ?? MAX_VISIBLE_PROJECTS_CLIENTS;
  // Map は挿入順を保つ。再申告は delete → set で末尾へ回すので、先頭が最も古い。
  const entries = new Map<string, Entry>();
  let localSelection: readonly string[] | null = null;

  function prune(): void {
    const t = now();
    for (const [clientId, entry] of entries) {
      if (entry.expiresAt <= t) {
        entries.delete(clientId);
      }
    }
  }

  function snapshot(): VisibleProjectsSnapshot {
    prune();
    let all = false;
    const ids = new Set<string>();
    for (const entry of entries.values()) {
      if (entry.all) {
        all = true;
      }
      for (const id of entry.ids) {
        ids.add(id);
      }
    }
    return {
      hasReports: entries.size > 0,
      isVisible: (projectId) => all || ids.has(projectId),
    };
  }

  return {
    report(clientId, report) {
      const before = snapshot();
      const ids = 'all' in report ? new Set<string>() : new Set(report.projectIds);
      entries.delete(clientId);
      entries.set(clientId, {
        all: 'all' in report,
        ids,
        expiresAt: now() + ttlMs,
      });
      while (entries.size > maxClients) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      const added: string[] = [];
      for (const id of ids) {
        if (!before.isVisible(id)) {
          added.push(id);
        }
      }
      return added;
    },
    snapshot,
    rememberLocalSelection(projectIds) {
      localSelection = [...projectIds];
    },
    getLocalSelection() {
      return localSelection === null ? null : [...localSelection];
    },
    isVisible(projectId) {
      return snapshot().isVisible(projectId);
    },
    get hasReports() {
      return snapshot().hasReports;
    },
  };
}
