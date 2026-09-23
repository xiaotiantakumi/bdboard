import type { CommandRunner } from '../../../application/ports/command-runner.js';

/**
 * commandRunner/gitPath/timeoutMs をまとめて受け渡すための共有型。
 *
 * createGitWorktreeScanner() がクロージャで捕捉していたこれらの値を、分割後の各モジュール
 * 関数へ明示引数として渡すために導入した (挙動は変えていない)。
 */
export interface ScannerDeps {
  readonly commandRunner: CommandRunner;
  readonly gitPath: string;
  readonly timeoutMs: number;
}
