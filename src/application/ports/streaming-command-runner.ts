import type {
  CommandFailureKind,
  CommandRunOptions,
} from './command-runner.js';

export interface StreamingCommandChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface StreamingCommandRunOptions
  extends CommandRunOptions {
  readonly onChunk: (chunk: StreamingCommandChunk) => void;
  readonly signal?: AbortSignal;
}

/**
 * 'buffer-limit-exceeded' は bdboard-l1t.9 Opus レビュー S8: 32MB バッファ上限到達で
 * 子プロセスを止めたケースを、汎用の非ゼロ終了(agent-exit-nonzero相当)と区別できるように
 * 独立させたもの。timeout/aborted と同様、runner が自発的に子を止めた結果であって
 * 子プロセス自身の異常終了ではない。
 */
export type StreamingCommandFailureKind =
  | CommandFailureKind
  | 'aborted'
  | 'buffer-limit-exceeded';

export interface StreamingCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly failureKind?: StreamingCommandFailureKind;
}

export interface StreamingCommandRunner {
  /** Run a command without a shell and report output as it arrives. */
  run(
    command: string,
    args: readonly string[],
    options: StreamingCommandRunOptions,
  ): Promise<StreamingCommandResult>;
}
