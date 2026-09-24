import { repoPathExistsSchema, repoTicketLandedSchema } from './schemas.js';
import { describeZodError } from '../zod-error-summary.js';

/**
 * チャットから使える「リポジトリの事実確認」ツール(bdboard-3tw.159.4)。
 *
 * 動機: bd の status だけでは「closed だがマージされていない」「マージ済みだが
 * コードが残っている」を区別できない。2026-08-29 に bdboard-3tw.151 の顛末を
 * 確定させたのは、チケットのコメントではなく origin/main に対する2つの読み取り
 * コマンドだった。それをチャット自身にやらせるためのツール。
 *
 * 設計の芯: **allowlist 方式**。任意のシェル実行はもちろん、任意の git
 * サブコマンドも開けない。ここが組み立てられる git コマンドは `log` と
 * `ls-tree` の2つだけで、引数も個別に検証したものしか載らない。bd ツールと
 * 同じく args 配列を組み立て、シェルを経由しない。
 *
 * bdboard-sso1.71: このファイルは git 引数の組み立て (buildRepoToolArgs) のみ。
 * ツール名/定義は ./definitions.ts、入力検証は ./schemas.ts、git 出力の絞り込みは
 * ./output-filter.ts に分割されている。公開エクスポートの入口は ../repo-tool-catalog.ts
 * (バレル)。
 */

const REPO_LOG_MAX_COMMITS = 20;
const REPO_PATH_MAX_MATCHES = 200;

/**
 * git の出力を呼び出し側で絞り込むための指示。どちらの絞り込みも git には
 * 渡さず、こちら側で行う。
 */
export type RepoOutputFilter =
  /** ls-tree の全パス列挙から検索語を含むものだけを残す。 */
  | { readonly kind: 'paths'; readonly needle: string; readonly maxMatches: number }
  /** git log の結果から、チケットIDが「そのIDとして」現れる行だけを残す。 */
  | { readonly kind: 'commits'; readonly ticketId: string };

export type RepoArgsBuildResult =
  | {
      readonly ok: true;
      readonly args: readonly string[];
      readonly outputFilter: RepoOutputFilter;
    }
  | { readonly ok: false; readonly error: string };

export const REPO_DEFAULT_REF = 'origin/main';

function buildPrefix(projectRootPath: string): readonly string[] {
  return ['-C', projectRootPath, '--no-pager'];
}

export function buildRepoToolArgs(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): RepoArgsBuildResult {
  switch (toolName) {
    case 'repo_ticket_landed': {
      const parsed = repoTicketLandedSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { ok: false, error: describeZodError(parsed.error) };
      }

      // --fixed-strings を必ず付ける。チケットIDには `.` が含まれ(bdboard-3tw.151)、
      // 既定の正規表現マッチだと `bdboard-3tw151` のような別IDまで拾ってしまう。
      // ただし --grep は境界の無い部分一致なので、これだけでは足りない
      // (`bdboard-x3` が `bdboard-x32` のコミットに当たる。PR#143 レビュー major-1
      // で実測)。ID として現れているかの判定は outputFilter 側で行う。
      // 末尾の `--` は ref とパスの取り違えを防ぐため。
      return {
        ok: true,
        args: [
          ...buildPrefix(projectRootPath),
          'log',
          `--max-count=${REPO_LOG_MAX_COMMITS}`,
          '--fixed-strings',
          `--grep=${parsed.data.ticketId}`,
          '--date=short',
          '--format=%h %ad %s',
          parsed.data.ref ?? REPO_DEFAULT_REF,
          '--',
        ],
        outputFilter: { kind: 'commits', ticketId: parsed.data.ticketId },
      };
    }
    case 'repo_path_exists': {
      const parsed = repoPathExistsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { ok: false, error: describeZodError(parsed.error) };
      }

      return {
        ok: true,
        args: [
          ...buildPrefix(projectRootPath),
          'ls-tree',
          '-r',
          '--name-only',
          parsed.data.ref ?? REPO_DEFAULT_REF,
          '--',
        ],
        outputFilter: {
          kind: 'paths',
          needle: parsed.data.pattern.toLowerCase(),
          maxMatches: REPO_PATH_MAX_MATCHES,
        },
      };
    }
    default:
      return { ok: false, error: `unknown tool: ${toolName}` };
  }
}
