/**
 * 「新しく報告」(bdboard-4y8q.6.8、docs/ISSUE-REPORTING.md 3節「手書きの下書き」) の画面側の判定。外部 I/O を持たない純粋関数。
 */

/** 書く画面が一緒に送るプロジェクト (サーバーの `project`。漏れ検出の鍵になる名前とルートのパス)。 */
export interface ReportProject {
  readonly name: string;
  readonly path: string;
}

/** ローカルで開いていないときにボタンの近くへ出す短い文 (正はサーバーの 403。issueDraftErrors.ts の MANUAL_LOCAL_ONLY_HELP が失敗後の説明)。 */
export const MANUAL_LOCAL_ONLY_NOTICE = 'ローカルで開いたときだけ書けます。';

/** サーバーのプロジェクト名・パスの上限 (issue-report-routes.ts の projectNameSchema / manual-routes の path と同じ値)。超えると 400 になる。 */
const PROJECT_NAME_MAX_CHARS = 200;
const PROJECT_PATH_MAX_CHARS = 1000;

/**
 * 開いているページのホスト名がローカル直アクセスのものか。サーバーのローカル判定 (src/interface/http/local-request.ts の hasExpectedLocalHost) が
 * 受ける `localhost` / `127.0.0.1` / `[::1]` と同じ集合 (ブラウザの hostname は IPv6 を `[::1]` と返すが、括弧なしも受ける)。
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
}

/**
 * 書く画面が送る `project`。ボードで選んでいるプロジェクトがちょうど 1 つで、その名前とルートのパスが分かるときだけ返す。
 * 選んでいない (全部)・2 つ以上・名前かパスが分からない・名前が空・サーバーの上限を超える (利用者が書いていない値で 400 になる) ときは undefined
 * (送らない)。プロジェクトを選ぶ欄は作らない。
 */
export function reportProjectOf(
  selectedProjectIds: readonly string[],
  projectNames: ReadonlyMap<string, string>,
  projectRootPaths: ReadonlyMap<string, string>,
): ReportProject | undefined {
  if (selectedProjectIds.length !== 1) return undefined;
  const id = selectedProjectIds[0];
  if (id === undefined) return undefined;
  const name = projectNames.get(id);
  const path = projectRootPaths.get(id);
  if (name === undefined || path === undefined) return undefined;
  if (name.trim() === '' || name.length > PROJECT_NAME_MAX_CHARS || path.length > PROJECT_PATH_MAX_CHARS) return undefined;
  return { name, path };
}
