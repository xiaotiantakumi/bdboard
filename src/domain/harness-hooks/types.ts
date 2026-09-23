/**
 * 注入したパックの hooks を注入先の `.claude/settings.json` へ登録する純粋関数群
 * (bdboard-pkr6.2)。
 *
 * スクリプトをコピーしただけでは Claude Code は hook を実行しない。settings.json
 * に登録して初めて効くので、注入時に自動でマージする。「手順として案内する」に
 * とどめないのは、文章ルールと同じ弱さ (読まれなければ効かない) を持つため。
 *
 * ここが純粋関数なのは、**既存の settings.json を壊さない**ことをテストで固定
 * したいから。ファイル I/O は infrastructure 側に置く。
 *
 * bdboard-sso1.66: このファイルは定数・型のみ。実装は ./command.ts (harnessHookMarker /
 * harnessHookCommand)・./merge.ts (mergeHarnessHooks)・./evaluate.ts (evaluateHooksState) に
 * 分割されている。公開エクスポートの入口は ../harness-hooks.ts (バレル)。
 */

/** 注入先プロジェクトの Claude Code 設定ファイル。 */
export const SETTINGS_RELATIVE_PATH = '.claude/settings.json';

/**
 * hook のコマンドに書き込むプロジェクトルート。Claude Code が hook 実行時に
 * 設定する環境変数で、絶対パスを書き込まない (worktree や別マシンで壊れる)。
 */
export const CLAUDE_PROJECT_DIR_PLACEHOLDER = '$CLAUDE_PROJECT_DIR';

/** pack.json の hook 宣言で `timeout` を省略したときの秒数。 */
export const DEFAULT_PACK_HOOK_TIMEOUT_SECONDS = 10;

/** パック内で hook スクリプトを置くディレクトリ (pack 根からの相対、POSIX)。 */
export const PACK_HOOKS_DIR = 'hooks';

/**
 * pack.json が宣言する hook 1件。
 *
 * `matcher` が空文字のときは settings.json 側に `matcher` キーを書かない
 * (Claude Code は Stop のような matcher を持たないイベントでこれを無視するので、
 * 書いても意味が無く差分だけが増える)。
 *
 * `timeout` は秒。settings.json には**常に**明示的な値を書く — Claude Code の
 * 既定 (600 秒) のままだと、bd を複数回叩く Stop hook が Dolt のロック競合時に
 * 毎ターン最大 10 分固まりうる (bdboard-pkr6.1 レビュー M3)。
 */
export interface PackHookDeclaration {
  readonly event: string;
  readonly matcher: string;
  readonly script: string;
  readonly timeout: number;
}

/** `mergeHarnessHooks` / `evaluateHooksState` が必要とする最小のパック情報。 */
export interface HarnessHookPack {
  readonly name: string;
  readonly hooks: readonly PackHookDeclaration[];
}

export type HarnessHooksState = 'ok' | 'missing' | 'partial' | 'none-declared';

export interface HarnessHooksEvaluation {
  readonly state: HarnessHooksState;
  /** 未登録の hook のコマンド文字列 (`ok` / `none-declared` では空)。 */
  readonly missingHooks: readonly string[];
}

export type MergeHarnessHooksResult =
  | {
      readonly ok: true;
      readonly settingsJson: string;
      readonly registered: readonly string[];
    }
  | { readonly ok: false; readonly settingsJson: null; readonly error: string };

// bdboard-sso1.66: 分割前は同一ファイル内の非公開型 (export なし) だった。./shared.ts と
// ./merge.ts の両方が使うため export を付けている。公開エクスポート面 (../harness-hooks.ts)
// には出さない。
export type JsonObject = Record<string, unknown>;
