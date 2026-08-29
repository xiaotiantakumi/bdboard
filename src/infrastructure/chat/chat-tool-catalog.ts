import {
  BD_TOOL_DEFINITIONS,
  buildBdToolArgs,
  type BdToolDefinition,
} from './bd-tool-catalog.js';
import {
  REPO_TOOL_DEFINITIONS,
  buildRepoToolArgs,
  isRepoToolName,
  type RepoOutputFilter,
} from './repo-tool-catalog.js';

/**
 * チャットエージェントに露出するツールの唯一の一覧(bdboard-3tw.159.4)。
 *
 * bd ツールと repo ツールでは実行するバイナリが違う(bd / git)ので、
 * 「どのツール名で何を実行するか」の対応はここ1か所に閉じる。MCP サーバーも
 * 各 CLI アダプタの allowedTools もこの一覧から派生させ、片方だけ更新して
 * 「定義はあるが呼べない」「呼べるが一覧に無い」がズレるのを防ぐ。
 */

export type ChatToolDefinition = BdToolDefinition;

export const CHAT_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  ...BD_TOOL_DEFINITIONS,
  ...REPO_TOOL_DEFINITIONS,
];

/** 実行するバイナリの種別。呼び出し元がパスへ解決する。 */
export type ChatToolExecutable = 'bd' | 'git';

export type ChatToolCommand =
  | {
      readonly ok: true;
      readonly executable: ChatToolExecutable;
      readonly args: readonly string[];
      readonly stdin?: string;
      /** git の出力を呼び出し側で絞り込む指示(repo ツールのみ)。 */
      readonly outputFilter?: RepoOutputFilter;
    }
  | { readonly ok: false; readonly error: string };

/**
 * ツール名から実行コマンドを組み立てる。
 *
 * 分岐はツール名の allowlist(isRepoToolName)だけで決まる。bd 側のビルダーが
 * git コマンドを返すことも、その逆も構造上あり得ない。
 */
export function buildChatToolCommand(
  toolName: string,
  rawArgs: unknown,
  projectRootPath: string,
): ChatToolCommand {
  if (isRepoToolName(toolName)) {
    const built = buildRepoToolArgs(toolName, rawArgs, projectRootPath);
    if (!built.ok) {
      return { ok: false, error: built.error };
    }
    return {
      ok: true,
      executable: 'git',
      args: built.args,
      outputFilter: built.outputFilter,
    };
  }

  const built = buildBdToolArgs(toolName, rawArgs, projectRootPath);
  if (!built.ok) {
    return { ok: false, error: built.error };
  }
  return {
    ok: true,
    executable: 'bd',
    args: built.args,
    ...(built.stdin !== undefined ? { stdin: built.stdin } : {}),
  };
}
