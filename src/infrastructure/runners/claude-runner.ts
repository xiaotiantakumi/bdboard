// Claude runners launch via StreamingCommandRunner when wired; otherwise they stay
// dispatch-disabled so the composition root can keep agent runners unwired until
// POST /api/runs is enabled.
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentRunner,
  RunOutcome,
  RunOutputSink,
  RunRequest,
} from '../../application/ports/agent-runner.js';
import type { StreamingCommandRunner } from '../../application/ports/streaming-command-runner.js';
import { buildClaudeCommand } from '../../application/runner/build-claude-args.js';
import type { RunMode } from '../../domain/run.js';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

const VALID_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;

// run が使える能力の一次の天井 (allowlist 主体)。DEFAULT_SETTING_SOURCES が
// user 層を落とすので、このリストは実測上そのまま上限として機能する
// (bdboard-jgx5)。実測: --setting-sources project,local の下では、ここに無く
// ユーザーのグローバル allow にだけ載っている `docker --version` は拒否され、
// ここに在る `git status --short` は実行された。列挙外の verb (rsync/perl/tar
// など) も同じ理由で通らない。リストを広げることがそのまま権限の拡大になる。
//
// 封じ込め: Bash(git:*) は任意パス破壊・任意コマンド実行・公開 push へ化ける。
// Bash(npm:*) は npm exec 等で任意コード実行。Bash(bd:*) は bare dolt push で
// private issue 履歴漏洩。Write/Edit のベア指定はパス制約なし。
// 挙動がエージェント書き換え可能なファイル (package.json / scripts/) で決まる
// コマンドは allowlist に入れない。allowlist の内側を通って worktree 外へ
// 任意コード実行できる (実測)。依存インストールと検証は run の外 (人間/CI) で行う。
// エージェントにビルド/検証をやらせる設計は別チケット (M-4) で扱う。
export const DEFAULT_ALLOWED_TOOLS = [
  // Glob / Grep はベアのまま残す。パススコープ付きで動くかを実プロセスで確認できて
  // おらず、fail-closed で「エージェントが何も探せない」無言の機能死になるリスクが
  // あるため。無スコープの Glob/Grep が worktree 外の情報をログへ載せうる点は、
  // ログ取得の local-only 化 (M-1(b)) で外部への流出経路を塞いでいる。
  'Glob',
  'Grep',
  'Bash(bd show:*)',
  'Bash(bd list:*)',
  'Bash(bd comment:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
] as const;

/** Bash(...:*) ワイルドカードを許可する verb（DEFAULT_ALLOWED_TOOLS の構造テスト用）。 */
export const ALLOWED_BASH_WILDCARD_VERBS = [
  'bd show',
  'bd list',
  'bd comment',
  'git status',
  'git diff',
  'git add',
  'git commit',
] as const;

/**
 * 読み込む設定ソースを user 抜きに固定する (--setting-sources)。
 * これが「allowlist 主体」を成立させている唯一の仕掛け (bdboard-jgx5)。
 *
 * 実測 (claude CLI 2.1.233, 2026-09-04)。差分は本フラグの有無だけ、
 * `--allowedTools` は Glob/Grep/Bash(git status:*) のみ:
 *   フラグ無し                        -> `docker --version` が実行された
 *                                        (出力 "Docker version 29.5.2")、denials 空
 *   --setting-sources project,local   -> `docker --version` は
 *                                        "This command requires approval" で拒否、
 *                                        permission_denials に記録
 * `Bash(docker:*)` はユーザーのグローバル ~/.claude/settings.json の
 * permissions.allow にのみ載っている。つまり本フラグは B-1 の
 * 「--allowedTools がグローバル allow との和集合になり上限として機能しない」
 * を根元で断つ。CLAUDE_CONFIG_DIR 固定と違い認証は壊れない (実測: 同 run が
 * 正常完了。認証は $HOME/.claude.json と keychain 側にあり設定ソースではない)。
 *
 * `''` (全ソース除外) にはしない。実測で CLAUDE.md と worktree の
 * `.claude/skills/` (= inject 済み bdboard-harness パック) まで落ちるため:
 *   --setting-sources ''              -> CLAUDE.md のルール不適用、slash_commands 54、
 *                                        プロジェクト skill 不可視
 *   --setting-sources project,local   -> CLAUDE.md のルール適用、slash_commands 55、
 *                                        プロジェクト skill 可視
 * user 層だけを落とすのが目的なので project,local を残すのが正しい。
 */
export const DEFAULT_SETTING_SOURCES = 'project,local';

/**
 * allowlist を貫通されたときの第二の天井 (--disallowedTools)。
 *
 * DEFAULT_SETTING_SOURCES が入った今、一次の天井は allowlist
 * (DEFAULT_ALLOWED_TOOLS) 側にある。それでもこの名指し deny を残すのは、
 * 残った project/local 層が worktree の中にあり、エージェント自身が
 * Edit(<worktree>/**) で `.claude/settings.json` を書けてしまうため。
 * deny は allow に勝つ (実測: グローバル allow に Bash(mv:*) があっても
 * --disallowedTools の有無だけで mv の実行有無が変わった) ので、自分で書いた
 * allow による昇格はここで止まる。M-2 の `.claude/settings.local.json` は
 * clearWorktreeLocalClaudeSettings() が起動直前に消す。
 * CLAUDE_CONFIG_DIR 固定は認証を壊すため撤回した (2026-09-04)。
 *
 * ベアな `Bash` は入れない。実測 (2026-09-04): `--disallowedTools Bash` は
 * 権限拒否ではなく **Bash ツールごとモデルの tool set から消える**
 * (「I don't have a Bash tool available」と返し tool_use が一件も出ない)。
 * 明示した `--allowedTools Bash(git status:*)` も道連れになるため、
 * 「ベア deny + 粒度 allow」という構成は CLI の意味論として成立しない。
 */
export const DENIED_TOOLS = [
  'WebFetch',
  'WebSearch',
  'Task',
  'Bash(sudo:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(pnpm:*)',
  'Bash(yarn:*)',
  'Bash(git push:*)',
  'Bash(bd dolt:*)',
  'Bash(mv:*)',
  'Bash(cp:*)',
  'Bash(rm:*)',
  'Bash(ln:*)',
  'Bash(chmod:*)',
  'Bash(chown:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(ssh:*)',
  'Bash(scp:*)',
  'Bash(docker:*)',
  'Bash(find:*)',
  'Bash(bash:*)',
  'Bash(sh:*)',
  'Bash(zsh:*)',
  'Bash(node:*)',
  'Bash(python:*)',
  'Bash(python3:*)',
  'Bash(eval:*)',
  'Bash(env:*)',
  'Bash(open:*)',
] as const;

const RUNNER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'USER',
  'SHELL',
] as const;

export interface ClaudeRunnerOptions {
  readonly claudePath?: string;
  readonly streamingRunner?: StreamingCommandRunner;
  readonly permissionMode?: string;
  readonly allowedTools?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * run 対象 worktree の .claude/settings.local.json を dispatch 前に削除する。
 * このファイルはグローバル gitignore で ignored なので git status --porcelain の
 * clean 判定に映らない。前の run がここへ権限やフックを仕込み、worktree は clean の
 * まま次の run が昇格した権限で始まる経路が成立していた (bdboard-54be.1 M-2)。
 * これが M-2 (worktree ローカル設定の持ち越し) の唯一のカバー。存在しなければ何もしない。
 */
export function clearWorktreeLocalClaudeSettings(worktreePath: string): void {
  try {
    const target = path.join(worktreePath, '.claude', 'settings.local.json');
    if (!fs.existsSync(target)) {
      return;
    }
    fs.rmSync(target, { force: true });
    console.warn(
      `removed worktree-local claude settings before run: ${target}`,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `failed to remove worktree-local claude settings in ${worktreePath}: ${detail}`,
    );
  }
}

function buildRunId(request: RunRequest, startedAt: Date): string {
  return `${request.ticketId}:${request.mode}:${startedAt.toISOString()}`;
}

function buildOutcome(
  runnerId: string,
  request: RunRequest,
  startedAt: Date,
  failureKind: RunOutcome['failureKind'],
  error: string,
  status: RunOutcome['run']['status'] = 'failed',
): RunOutcome {
  return {
    ok: false,
    failureKind,
    error,
    run: {
      id: buildRunId(request, startedAt),
      ticketId: request.ticketId,
      runner: runnerId,
      mode: request.mode,
      status,
      startedAt,
      finishedAt: startedAt,
      sessionId: request.sessionId,
    },
  };
}

function resolveTimeoutMs(options?: ClaudeRunnerOptions): number {
  if (options?.timeoutMs !== undefined) {
    return options.timeoutMs;
  }

  const fromEnv = process.env.BDBOARD_RUN_TIMEOUT_MS;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_TIMEOUT_MS;
}

function resolvePermissionMode(options?: ClaudeRunnerOptions): string {
  let mode: string | undefined;

  if (options?.permissionMode !== undefined && options.permissionMode !== '') {
    mode = options.permissionMode;
  } else {
    const fromEnv = process.env.BDBOARD_RUN_PERMISSION_MODE;
    if (fromEnv !== undefined && fromEnv.trim() !== '') {
      mode = fromEnv.trim();
    }
  }

  if (mode === undefined) {
    // acceptEdits だと Edit(<worktree>/**) のパススコープが無視される（claude CLI
    // 2.1.233 実測）。M-1 の封じ込めそのものが無効化されるため default を使う。
    // default でも `-p`（非対話）のまま許可内の操作は確認を求めず進む（実測）。
    // bypassPermissions は明示設定時のみ。
    return 'default';
  }

  if (!(VALID_PERMISSION_MODES as readonly string[]).includes(mode)) {
    console.warn(
      `unknown BDBOARD_RUN_PERMISSION_MODE "${mode}", falling back to default`,
    );
    return 'default';
  }

  return mode;
}

const RUNNER_ENV_NESTED_SESSION_DENYLIST = new Set([
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET',
]);

/**
 * 子プロセスへ渡す環境変数を allowlist で組み立てる。
 * denylist ではなく allowlist にすることで、サーバー起動時に kv_inject 等で
 * 注入された未知のシークレットが増えても自動的に落ちる。
 */
export function buildRunnerEnv(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const key of RUNNER_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) {
      // プレフィックス許可の唯一の例外。実測 (2026-09-04) で子プロセスの env に
      // CLAUDE_CODE_MESSAGING_TOKEN / _SOCKET が届いていた。これらは「親セッション
      // への制御チャネル」の資格情報であって claude CLI の設定ではないので、
      // 新しい独立セッションである run に渡す理由が無い（渡すと子が入れ子
      // セッションだと誤認する副作用もある）。allowlist の中の denylist という形は
      // 歪だが、プレフィックス許可を捨てると正当な ANTHROPIC_*/CLAUDE_* 設定まで
      // 落ちるので、例外を明示する方を選んでいる。
      // CLAUDE_CONFIG_DIR は落とさない。親が正当に設定している環境ではそこに認証情報があり、
      // 子で落とすと既定の $HOME/.claude.json を見に行って "Not logged in" になる (実測)。
      if (RUNNER_ENV_NESTED_SESSION_DENYLIST.has(key)) {
        continue;
      }
      env[key] = value;
    }
  }

  return env;
}

function buildWorktreeScopedTools(worktreePath: string): readonly string[] {
  // 多層防御。provisioner 側で ticket id を allowlist 検証しているが、cwd は
  // RunRequest 経由で来るのでここでも壊れた形を弾く。fail-closed。
  if (/[)(*\n\r]/.test(worktreePath)) {
    throw new Error(
      `worktree path contains characters that break the permission rule: ${worktreePath}`,
    );
  }

  // Write(<path>) は CLI 自身が「file permission checks に使われない」と診断する。
  // Edit(<glob>) が Write を含む全ファイル編集ツールを覆う（claude CLI 2.1.233 実測）。
  //
  // 先頭のスラッシュ2つが load-bearing。claude CLI のパスルールは既定で
  // 「プロジェクト相対」と解釈されるため、`Edit(/abs/path/**)` と1つだけ書くと
  // 絶対パスが相対パス扱いになり **何にも一致しない**。実測 (2.1.233):
  //   Edit(/tmp/x/**)  → worktree 内の ./in.txt すら DENIED (ファイル未作成)
  //   Edit(//tmp/x/**) → 同じ操作が通る
  // fail-closed なので危険側には倒れないが、エージェントが一切ファイルを
  // 編集できず機能が無言で死ぬ。`--` 終端と同じく、単体テストでは
  // 「期待した文字列と一致するか」しか見えないので実プロセスでしか気づけない。
  const absolute = worktreePath.startsWith('/') ? worktreePath : `/${worktreePath}`;
  return [`Read(/${absolute}/**)`, `Edit(/${absolute}/**)`];
}

function resolveAllowedTools(
  options?: ClaudeRunnerOptions,
): readonly string[] | undefined {
  if (options?.allowedTools !== undefined) {
    return options.allowedTools.length > 0 ? options.allowedTools : undefined;
  }

  const fromEnv = process.env.BDBOARD_RUN_ALLOWED_TOOLS;
  if (fromEnv !== undefined) {
    // Empty string explicitly opts out of --allowedTools (ambient Claude config).
    if (fromEnv === '') {
      return undefined;
    }

    // BDBOARD_RUN_ALLOWED_TOOLS は JSON 文字列配列（例:
    // '["Read","Bash(git status:*)"]'）。カンマ分割だと Bash(git diff:*) 等が壊れる。
    try {
      const parsed: unknown = JSON.parse(fromEnv);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((entry) => typeof entry === 'string' && entry !== '')
      ) {
        return parsed;
      }
      console.warn(
        'BDBOARD_RUN_ALLOWED_TOOLS must be a JSON array of non-empty strings; falling back to defaults',
      );
    } catch {
      console.warn(
        'BDBOARD_RUN_ALLOWED_TOOLS is not valid JSON; falling back to defaults',
      );
    }
    return DEFAULT_ALLOWED_TOOLS;
  }

  return DEFAULT_ALLOWED_TOOLS;
}

/**
 * Shared factory for the official `claude` runners. `spawn` and `resume` differ
 * only in which mode they accept and in their id; keeping one implementation
 * prevents the two from drifting apart when dispatch is eventually implemented.
 */
export function createClaudeRunner(
  id: string,
  mode: RunMode,
  options?: ClaudeRunnerOptions,
): AgentRunner {
  const claudePath = options?.claudePath ?? process.env.BDBOARD_CLAUDE_PATH ?? 'claude';
  const streamingRunner = options?.streamingRunner;
  const permissionMode = resolvePermissionMode(options);
  const allowedTools = resolveAllowedTools(options);
  const timeoutMs = resolveTimeoutMs(options);

  return {
    id,
    experimental: false,
    supports: (request: RunRequest) => request.mode === mode,
    async dispatch(
      request: RunRequest,
      sink?: RunOutputSink,
    ): Promise<RunOutcome> {
      const startedAt = new Date();

      let command: string;
      let args: readonly string[];
      try {
        const effectiveAllowedTools =
          allowedTools === undefined
            ? undefined
            : [
                ...allowedTools,
                ...buildWorktreeScopedTools(request.cwd),
              ];
        ({ command, args } = buildClaudeCommand(request, {
          claudePath,
          permissionMode,
          settingSources: DEFAULT_SETTING_SOURCES,
          allowedTools: effectiveAllowedTools,
          disallowedTools: DENIED_TOOLS,
        }));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        return buildOutcome(id, request, startedAt, 'invalid-request', detail);
      }

      if (streamingRunner === undefined) {
        return buildOutcome(
          id,
          request,
          startedAt,
          'dispatch-disabled',
          `dispatch disabled (no streaming runner wired): would run: ${command} ${args.join(' ')}`,
        );
      }

      // cwd の形が buildWorktreeScopedTools を通過し、実際に起動する直前まで来てから
      // 消す。ここより前だと (a) 壊れた cwd でも削除が走り、(b) dispatch-disabled で
      // 起動しないのにファイルだけ消える。
      clearWorktreeLocalClaudeSettings(request.cwd);

      const onChunk = sink?.onChunk ?? (() => {});

      const result = await streamingRunner.run(command, args, {
        cwd: request.cwd,
        env: buildRunnerEnv(),
        timeoutMs,
        onChunk,
        signal: sink?.signal,
      });

      const finishedAt = new Date();
      const runId = buildRunId(request, startedAt);

      if (result.failureKind === 'spawn-failed') {
        return {
          ok: false,
          failureKind: 'runner-unavailable',
          error: result.stderr || 'failed to spawn claude',
          run: {
            id: runId,
            ticketId: request.ticketId,
            runner: id,
            mode: request.mode,
            status: 'failed',
            startedAt,
            finishedAt,
            sessionId: request.sessionId,
            exitCode: result.exitCode,
            error: result.stderr || undefined,
          },
        };
      }

      if (result.failureKind === 'aborted') {
        return {
          ok: false,
          failureKind: 'failed',
          error: result.stderr || 'run aborted',
          run: {
            id: runId,
            ticketId: request.ticketId,
            runner: id,
            mode: request.mode,
            status: 'cancelled',
            startedAt,
            finishedAt,
            sessionId: request.sessionId,
            exitCode: result.exitCode,
            error: result.stderr || undefined,
          },
        };
      }

      if (result.exitCode === 0) {
        return {
          ok: true,
          run: {
            id: runId,
            ticketId: request.ticketId,
            runner: id,
            mode: request.mode,
            status: 'succeeded',
            startedAt,
            finishedAt,
            sessionId: request.sessionId,
            exitCode: result.exitCode,
          },
        };
      }

      return {
        ok: false,
        failureKind: 'failed',
        error: result.stderr || `claude exited with code ${result.exitCode}`,
        run: {
          id: runId,
          ticketId: request.ticketId,
          runner: id,
          mode: request.mode,
          status: 'failed',
          startedAt,
          finishedAt,
          sessionId: request.sessionId,
          exitCode: result.exitCode,
          error: result.stderr || undefined,
        },
      };
    },
  };
}
