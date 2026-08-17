/** exitCode だけでは区別できない失敗種別。正常終了と通常の非ゼロ終了では undefined。 */
export type CommandFailureKind = 'spawn-failed' | 'timeout';

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly failureKind?: CommandFailureKind;
}

export interface CommandRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** 与えたら子プロセスのstdinへ書いてcloseする。未指定なら従来どおり何もしない。 */
  readonly input?: string;
  /** 与えたら子プロセスの環境変数を「これだけ」に置き換える(継承しない)。 */
  readonly env?: Readonly<Record<string, string>>;
}

export interface CommandRunner {
  /** Run a command WITHOUT a shell (args array passed through).
   *  If the process fails to spawn, do not throw - return a CommandResult with exitCode !== 0. */
  run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}
