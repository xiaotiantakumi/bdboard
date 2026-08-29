import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CommandRunner, CommandResult } from '../../application/ports/command-runner.js';
import type { BdToolDefinition } from './bd-tool-catalog.js';

/**
 * チャットから使える「配信中ビルドの由来」ツール(bdboard-3tw.159.5)。
 *
 * 動機: 「マージ済みだが常時稼働サーバーをリビルド/再起動していないので画面に
 * 残っている」は、この repo で最頻の食い違い(CLAUDE.md「Always-On Local
 * Hosting」)。`npm run start` は tsx を watch なしで動かし、静的な `web/dist`
 * を配信するだけなので、マージしただけでは server 側も UI 側も反映されない。
 * この事実をユーザーに説明できるのは、配信中のビルドが何であるかを知っている
 * 場合だけ。
 *
 * bd_* / repo_* ツール(bd-tool-catalog.ts / repo-tool-catalog.ts)は「1回の
 * コマンド実行の結果をそのまま(絞り込んで)返す」という共通の実行モデルに
 * 乗っているが、このツールは (1) ビルド時メタファイルの読み取り(fs)と
 * (2) origin/main の現在値の取得(git)、場合により (3) その差分の算出(git)
 * という複数ステップの組み合わせなので、その実行モデルには乗せていない。
 * そのため chat-tool-catalog.ts の `buildChatToolCommand`(単一コマンドの
 * 組み立てだけを担う)には加えず、`CHAT_TOOL_DEFINITIONS` へのツール定義の
 * 追加(ツール一覧への露出)と、bd-mcp-server.ts での実行時の分岐だけで配線する。
 *
 * readonly: git は `rev-parse` / `rev-list --count` の読み取り専用サブコマンド
 * しか実行しない。再起動・リビルドをこのツールから実行することはない。
 */

export const DEPLOY_STATUS_TOOL_NAME = 'deploy_status' as const;

export function isDeployStatusToolName(
  toolName: string,
): toolName is typeof DEPLOY_STATUS_TOOL_NAME {
  return toolName === DEPLOY_STATUS_TOOL_NAME;
}

export const DEPLOY_STATUS_TOOL_DEFINITION: BdToolDefinition = {
  name: DEPLOY_STATUS_TOOL_NAME,
  description:
    '常時稼働サーバーが配信中の web/dist ビルドが、origin/main の現在値から' +
    '何コミット遅れているかを調べる(読み取り専用。再起動/リビルドは行わない)',
  writes: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
};

export interface DeployStatusToolDeps {
  readonly commandRunner: CommandRunner;
  readonly projectRootPath: string;
  readonly gitPath: string;
  readonly timeoutMs: number;
  /**
   * web/dist の場所。省略時は `<projectRootPath>/web/dist`。テストで実ファイル
   * システムを汚さず差し替えられるようにここだけ上書き可能にしてある(bd の
   * パス/git のパスと同じ考え方)。
   */
  readonly webDistDir?: string;
}

/**
 * bd-mcp-server.ts の handleToolsCall と同じ MCP tools/call レスポンス形。
 * `Record<string, unknown>` を直接使うのは、この値をそのまま
 * `Promise<Record<string, unknown>>` を返す handleToolsCall から返すため
 * (名前付きインターフェースだと index signature 不足で型エラーになる —
 * TSの「フレッシュなオブジェクトリテラルだけが index signature 型に構造的に
 * 代入できる」制約による)。
 */
export type DeployStatusToolResult = Record<string, unknown> & {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError: boolean;
};

interface BuildMeta {
  readonly sha?: string;
  readonly builtAt?: string;
}

/** scripts/write-build-meta.mjs (web/package.json の `npm run build` から実行) が書き出す形式。壊れていれば読めなかった扱いにする。 */
async function readBuildMeta(webDistDir: string): Promise<BuildMeta | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(webDistDir, 'build-meta.json'), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      sha: typeof record.sha === 'string' ? record.sha : undefined,
      builtAt: typeof record.builtAt === 'string' ? record.builtAt : undefined,
    };
  } catch {
    return null;
  }
}

async function readDistMTime(webDistDir: string): Promise<string | null> {
  try {
    const stat = await fs.stat(webDistDir);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

/** git rev-parse / rev-list が返しうる完全なSHA(短縮形も許す)かどうか。 */
const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function textResult(text: string, isError = false): DeployStatusToolResult {
  return { isError, content: [{ type: 'text', text }] };
}

function summarizeFailure(result: CommandResult): string {
  const parts = [result.stderr.trim(), result.stdout.trim()].filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n') : 'command failed';
}

export async function runDeployStatusTool(
  deps: DeployStatusToolDeps,
): Promise<DeployStatusToolResult> {
  const webDistDir = deps.webDistDir ?? path.join(deps.projectRootPath, 'web', 'dist');

  const distMTime = await readDistMTime(webDistDir);
  if (distMTime === null) {
    return textResult(
      'web/dist not found. サーバーは API only で配信中(UIは未ビルド)。' +
        'npm run build:web が必要(このツールからは実行できません)。',
    );
  }

  const meta = await readBuildMeta(webDistDir);

  const originResult = await deps.commandRunner.run(
    deps.gitPath,
    ['-C', deps.projectRootPath, 'rev-parse', 'origin/main'],
    { cwd: deps.projectRootPath, timeoutMs: deps.timeoutMs },
  );

  if (originResult.exitCode !== 0) {
    return textResult(
      `origin/main の解決に失敗しました: ${summarizeFailure(originResult)}`,
      true,
    );
  }

  const originMainSha = originResult.stdout.trim();
  const fields: string[] = [
    `buildSha=${meta?.sha ?? 'unknown'}`,
    `builtAt=${meta?.builtAt ?? 'unknown'}`,
    `distMTime=${distMTime}`,
    `originMainSha=${originMainSha}`,
  ];

  const buildSha = meta?.sha;
  if (buildSha === undefined || !GIT_SHA_PATTERN.test(buildSha)) {
    fields.push(
      'commitsBehind=unknown (build-meta.json が無いか壊れています。' +
        'build-meta.json 導入(bdboard-3tw.159.5)より前のビルドの可能性があります。' +
        '再ビルドしないと比較できません)',
    );
    return textResult(fields.join(' '));
  }

  // --left-right で「build 側だけの独自コミット(ahead)」も同時に見る。0でなければ
  // buildSha が origin/main の祖先ではない(revert・force-push・別ブランチからの
  // ビルド等)ということなので、単純な rev-list --count buildSha..origin/main を
  // 「遅れコミット数」として鵜呑みにできない(このrepoではdirect-to-mainもforce-push
  // も禁止だが、履歴として断定はできない前提で扱う)。
  const diffResult = await deps.commandRunner.run(
    deps.gitPath,
    [
      '-C',
      deps.projectRootPath,
      'rev-list',
      '--left-right',
      '--count',
      `${buildSha}...${originMainSha}`,
    ],
    { cwd: deps.projectRootPath, timeoutMs: deps.timeoutMs },
  );

  if (diffResult.exitCode !== 0) {
    fields.push(
      `commitsBehind=unknown (${summarizeFailure(diffResult)}; buildSha がこの` +
        'checkoutの履歴に見つからない可能性があります。shallow cloneや削除済みブランチ由来かもしれません)',
    );
    return textResult(fields.join(' '));
  }

  const [aheadRaw, behindRaw] = diffResult.stdout.trim().split(/\s+/);
  const ahead = aheadRaw !== undefined && /^\d+$/.test(aheadRaw) ? Number(aheadRaw) : null;
  const behind = behindRaw !== undefined && /^\d+$/.test(behindRaw) ? Number(behindRaw) : null;

  if (ahead === null || behind === null) {
    fields.push(`commitsBehind=unknown (unexpected rev-list output: "${diffResult.stdout.trim()}")`);
    return textResult(fields.join(' '));
  }

  fields.push(`commitsBehind=${behind}`);
  if (ahead > 0) {
    fields.push(
      `commitsAheadOfMain=${ahead} (buildSha が origin/main の祖先ではありません。` +
        'このビルドは別ブランチ由来か、その後 origin/main 側で revert/巻き戻しが' +
        'あった可能性があります)',
    );
  }

  return textResult(fields.join(' '));
}
