import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';

/**
 * bdboard-o1e5: bd の読み取りは `--readonly` 固定のため、bd 本体の Dolt
 * sql-server 自動起動が効かない。PC 再起動などでサーバーが止まると全プロジェクトが
 * 「dolt server unreachable ... try: bd dolt start」でステータスエラーになる。
 * この CommandRunner デコレータは `--readonly` 付きの bd 呼び出しがその理由で
 * 失敗したときだけ、そのプロジェクトで `bd -C <root> dolt start` を1回実行し、
 * 元の呼び出しを1回だけ再試行する。
 *
 * 安全性: `dolt start` はサーバープロセスを起動するだけでデータを書かない
 * (docs/ARCHITECTURE.md「bdへの読み取りは --readonly 固定」の唯一の例外)。
 * プロジェクトごとに単一飛行 + クールダウンで、壊れたままのプロジェクトに
 * start を連打しない。再試行も失敗した結果はそのまま返す(エラーは見える)。
 */
const UNREACHABLE_PATTERN = /dolt server unreachable/i;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;

export function isDoltServerUnreachable(result: CommandResult): boolean {
  if (result.exitCode === 0) {
    return false;
  }
  return UNREACHABLE_PATTERN.test(`${result.stdout}\n${result.stderr}`);
}

function projectRootOf(
  args: readonly string[],
  options: CommandRunOptions | undefined,
): string | undefined {
  const idx = args.indexOf('-C');
  const fromArgs = idx >= 0 ? args[idx + 1] : undefined;
  return fromArgs ?? options?.cwd;
}

export interface DoltAutostartOptions {
  readonly cooldownMs?: number;
  readonly startTimeoutMs?: number;
  readonly now?: () => number;
  /** false を返した projectRoot では start しない (表示中プロジェクトだけに絞る)。未指定は常に許可。 */
  readonly shouldStart?: (projectRoot: string) => boolean;
}

export function createDoltAutostartCommandRunner(
  inner: CommandRunner,
  options: DoltAutostartOptions = {},
): CommandRunner {
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  /** root -> 進行中の start (単一飛行)。 */
  const inFlight = new Map<string, Promise<void>>();
  /** root -> 最後に start を試みた時刻 (クールダウン)。 */
  const lastAttempt = new Map<string, number>();

  async function startOnce(
    command: string,
    root: string,
  ): Promise<'started' | 'skipped'> {
    // 表示中でないプロジェクトの Dolt は起動しない (bdboard-o1e5)。クールダウンも消費しない。
    if (options.shouldStart !== undefined && !options.shouldStart(root)) {
      return 'skipped';
    }
    const pending = inFlight.get(root);
    if (pending) {
      await pending;
      return 'started';
    }
    const last = lastAttempt.get(root);
    if (last !== undefined && now() - last < cooldownMs) {
      return 'skipped';
    }
    lastAttempt.set(root, now());
    const run = inner
      .run(command, ['-C', root, 'dolt', 'start'], { timeoutMs: startTimeoutMs })
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        inFlight.delete(root);
      });
    inFlight.set(root, run);
    await run;
    return 'started';
  }

  return {
    async run(command, args, runOptions) {
      const result = await inner.run(command, args, runOptions);
      if (!args.includes('--readonly') || !isDoltServerUnreachable(result)) {
        return result;
      }
      const root = projectRootOf(args, runOptions);
      if (root === undefined) {
        return result;
      }
      const outcome = await startOnce(command, root);
      if (outcome === 'skipped') {
        return result;
      }
      return inner.run(command, args, runOptions);
    },
  };
}
