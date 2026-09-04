// Claude runners launch via StreamingCommandRunner when wired; otherwise they stay
// dispatch-disabled so the composition root can keep agent runners unwired until
// POST /api/runs is enabled.
import fs from 'node:fs';
import os from 'node:os';
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
 * run に対して絶対に許さない能力の天井。permissions.deny は allow より優先されるので、
 * ユーザーのグローバル設定・worktree 内のプロジェクト設定のどちらが allow していても塞がる。
 *
 * ベアな `Bash` は入れない: DEFAULT_ALLOWED_TOOLS が許している Bash(git status:*) 等まで
 * 一緒に塞いでしまい、機能が死ぬ。allow していない能力と、allow の内側をすり抜けうる
 * 危険な verb だけを名指しする。
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
  readonly claudeConfigDir?: string;
  readonly timeoutMs?: number;
}

export interface ManagedClaudeConfigCheck {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * run 用の claude 設定ディレクトリ。ユーザーの ~/.claude を読ませないための天井。
 * --allowedTools はユーザーのグローバル permissions.allow との「和集合」になるため
 * 上限として機能しない (実測: allowlist に無い Bash(mv:*) がグローバル allow 経由で通った)。
 * CLAUDE_CONFIG_DIR を bdboard 管理下に固定して、そもそもユーザー設定を読ませない。
 */
export function resolveManagedClaudeConfigDir(): string {
  const fromEnv = process.env.BDBOARD_AGENT_RUN_CLAUDE_CONFIG_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  return path.join(os.homedir(), '.bdboard', 'agent-run-claude-config');
}

/**
 * 管理ディレクトリを毎 dispatch 前に作り直し、bdboard が書いた settings.json 以外の
 * 設定が permissions に寄与していないことを検査する。
 * 「起動時に一度」ではなく毎回にしているのは、run 中/run 間にエージェント自身が
 * この設定を書き換えて次の run を昇格させる経路 (M-2 と同型) を塞ぐため。
 * 検査に落ちたら run を拒否する (fail-closed)。
 */
export function ensureManagedClaudeConfig(dir: string): ManagedClaudeConfigCheck {
  try {
    fs.mkdirSync(dir, { recursive: true });

    const expectedSettings = {
      permissions: {
        defaultMode: 'default',
        allow: [] as string[],
        deny: [...DENIED_TOOLS],
      },
    };

    const settingsPath = path.join(dir, 'settings.json');
    const tempPath = path.join(dir, '.settings.json.tmp');
    fs.writeFileSync(tempPath, `${JSON.stringify(expectedSettings, null, 2)}\n`);
    fs.renameSync(tempPath, settingsPath);

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown;
    if (JSON.stringify(written) !== JSON.stringify(expectedSettings)) {
      return {
        ok: false,
        error: 'settings.json content does not match expected permissions after write',
      };
    }

    const unmanagedNames = new Set([
      'settings.local.json',
      '.claude.json',
      'CLAUDE.md',
    ]);
    for (const name of fs.readdirSync(dir)) {
      if (name === 'settings.json') {
        continue;
      }
      if (unmanagedNames.has(name)) {
        return {
          ok: false,
          error: `unmanaged claude config file found in ${dir}: ${name}`,
        };
      }
    }

    return { ok: true };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: detail };
  }
}

/**
 * run 対象 worktree の .claude/settings.local.json を dispatch 前に削除する。
 * このファイルはグローバル gitignore で ignored なので git status --porcelain の
 * clean 判定に映らない。前の run がここへ権限やフックを仕込み、worktree は clean の
 * まま次の run が昇格した権限で始まる経路が成立していた (bdboard-54be.1 M-2)。
 * CLAUDE_CONFIG_DIR の固定はユーザーレベル設定にしか効かないので、プロジェクト
 * レベルはここで個別に潰す。存在しなければ何もしない。
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

const RUNNER_ENV_CLAUDE_PREFIX_DENYLIST = new Set([
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  // 親から継承した CLAUDE_CONFIG_DIR が素通しすると B-1 の managed config 天井が
  // 無効化され、ユーザーの ~/.claude permissions.allow と --allowedTools が和集合になる。
  'CLAUDE_CONFIG_DIR',
]);

/**
 * 子プロセスへ渡す環境変数を allowlist で組み立てる。
 * denylist ではなく allowlist にすることで、サーバー起動時に kv_inject 等で
 * 注入された未知のシークレットが増えても自動的に落ちる。
 */
export function buildRunnerEnv(
  source: NodeJS.ProcessEnv = process.env,
  options?: { readonly claudeConfigDir?: string },
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
      // セッションだと誤認する副作用もある）。CLAUDE_CONFIG_DIR も同様に、親の
      // ~/.claude を子に見せないため denylist に載せる。allowlist の中の denylist
      // という形は歪だが、プレフィックス許可を捨てると正当な ANTHROPIC_*/CLAUDE_*
      // 設定まで落ちるので、例外を明示する方を選んでいる。
      if (RUNNER_ENV_CLAUDE_PREFIX_DENYLIST.has(key)) {
        continue;
      }
      env[key] = value;
    }
  }

  if (options?.claudeConfigDir !== undefined && options.claudeConfigDir !== '') {
    env.CLAUDE_CONFIG_DIR = options.claudeConfigDir;
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
  const claudeConfigDir =
    options?.claudeConfigDir ?? resolveManagedClaudeConfigDir();

  return {
    id,
    experimental: false,
    supports: (request: RunRequest) => request.mode === mode,
    async dispatch(
      request: RunRequest,
      sink?: RunOutputSink,
    ): Promise<RunOutcome> {
      const startedAt = new Date();

      const configCheck = ensureManagedClaudeConfig(claudeConfigDir);
      if (!configCheck.ok) {
        return buildOutcome(
          id,
          request,
          startedAt,
          'invalid-request',
          `managed claude config is not usable: ${configCheck.error ?? 'unknown'}`,
        );
      }

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
        env: buildRunnerEnv(process.env, { claudeConfigDir }),
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
