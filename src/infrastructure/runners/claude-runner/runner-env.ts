// bdboard-sso1.29: claude-runner.ts から move-only で分割。
// 子プロセスへ渡す環境変数の allowlist 組み立て。

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
