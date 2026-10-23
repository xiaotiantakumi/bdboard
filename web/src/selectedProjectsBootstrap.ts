// bdboard-u8p9: スマホがトンネル経由で初めて開いたとき、PC の現在のプロジェクト選択で始める。
//
// 優先順位 (React を描画する前に localStorage へ書き込んで決める):
//   1. URL の `?projects=<id,id>` (QR / phone-url.sh が付ける)。端末が自分の選択を持っていても上書きし、
//      適用後に URL から取り除く (`t` トークンと同じ扱い)。
//   2. この端末に保存済みの選択があればそれを使う (何もしない)。
//   3. 無ければサーバーが覚えている PC の選択 (GET /api/ui/selected-projects)。
// 選択が空 (= 全プロジェクト表示) のときは何も書かない。

import { UI_STORAGE_KEYS } from './uiPersistedState/storageKeys';

export const PROJECTS_QUERY_PARAM = 'projects';
const SERVER_SELECTION_TIMEOUT_MS = 1500;

/** `projects` クエリの値。ID はカンマ区切りで、各 ID は URL エンコードされている (プロジェクト ID はパス)。 */
export function encodeProjectsParam(projectIds: readonly string[]): string {
  return projectIds.map((id) => encodeURIComponent(id)).join(',');
}

/** `projects` クエリを ID 配列にする。無い・空・壊れているときは null (= 適用しない)。 */
export function parseProjectsParam(search: string): string[] | null {
  // URLSearchParams.get は値を 1 回デコードする。ID の中の `%2C` が区切りの `,` に化けないよう、
  // 生の文字列から切り出して、区切った後に ID ごとにデコードする。
  const prefix = `${PROJECTS_QUERY_PARAM}=`;
  const pair = search
    .replace(/^\?/, '')
    .split('&')
    .find((part) => part.startsWith(prefix));
  const raw = pair === undefined ? null : pair.slice(prefix.length);
  if (raw === null || raw.length === 0) {
    return null;
  }
  const ids: string[] = [];
  for (const part of raw.split(',')) {
    if (part.length === 0) continue;
    try {
      const id = decodeURIComponent(part);
      if (id.length > 0 && !ids.includes(id)) ids.push(id);
    } catch {
      return null;
    }
  }
  return ids.length > 0 ? ids : null;
}

/** `projects` を取り除いた相対 URL (path + search + hash)。パラメータが無ければ null。 */
export function stripProjectsParam(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(PROJECTS_QUERY_PARAM)) {
    return null;
  }
  url.searchParams.delete(PROJECTS_QUERY_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function hasStoredSelectedProjects(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(UI_STORAGE_KEYS.selectedProjectIds) !== null;
  } catch {
    // 判定できないときは「保存済み」に倒して上書きしない。
    return true;
  }
}

function writeSelection(storage: Pick<Storage, 'setItem'>, projectIds: readonly string[]): void {
  try {
    storage.setItem(UI_STORAGE_KEYS.selectedProjectIds, JSON.stringify(projectIds));
  } catch {
    // localStorage が使えない環境では諦める。
  }
}

/** サーバーが覚えている PC の選択。取れない・未申告・空のときは null。 */
export async function fetchServerSelectedProjects(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SERVER_SELECTION_TIMEOUT_MS,
): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('/api/ui/selected-projects', { signal: controller.signal });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const ids = (body as { projectIds?: unknown }).projectIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
      return null;
    }
    return ids.length > 0 ? (ids as string[]) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface BootstrapDeps {
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly href: string;
  readonly replaceUrl: (relativeUrl: string) => void;
  readonly fetchServerSelection: () => Promise<string[] | null>;
}

/** 描画前に一度だけ呼ぶ。戻り値はどの経路で適用したか (テスト・診断用)。 */
export async function bootstrapSelectedProjects(
  deps: BootstrapDeps,
): Promise<'query' | 'server' | 'none'> {
  const url = new URL(deps.href);
  const fromQuery = parseProjectsParam(url.search);
  const stripped = stripProjectsParam(deps.href);
  if (stripped !== null) {
    // 壊れた値でも URL からは取り除く。
    deps.replaceUrl(stripped);
  }
  if (fromQuery !== null) {
    writeSelection(deps.storage, fromQuery);
    return 'query';
  }
  if (hasStoredSelectedProjects(deps.storage)) {
    return 'none';
  }
  const fromServer = await deps.fetchServerSelection();
  if (fromServer !== null) {
    writeSelection(deps.storage, fromServer);
    return 'server';
  }
  return 'none';
}

/** ブラウザ環境での呼び出し。例外は握りつぶして必ず解決する (起動を止めない)。 */
export async function bootstrapSelectedProjectsInBrowser(): Promise<void> {
  try {
    await bootstrapSelectedProjects({
      storage: window.localStorage,
      href: window.location.href,
      replaceUrl: (relative) => window.history.replaceState(window.history.state, '', relative),
      fetchServerSelection: () => fetchServerSelectedProjects(),
    });
  } catch {
    // 選択の引き継ぎは補助機能。失敗しても通常どおり起動する。
  }
}
