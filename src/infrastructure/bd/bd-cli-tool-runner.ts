import type { CommandRunner } from '../../application/ports/command-runner.js';
import {
  BdError,
  type BdErrorKind,
} from '../../application/ports/issue-repository.js';
import { buildBdToolArgs } from '../chat/bd-tool-catalog.js';
import { withLockContentionRetry } from './bd-retry.js';

function classifyBdError(
  exitCode: number,
  combinedOutput: string,
): BdErrorKind {
  if (
    combinedOutput.includes('not a beads project') ||
    combinedOutput.includes('no .beads') ||
    combinedOutput.includes('.beads not found') ||
    combinedOutput.includes('beads directory')
  ) {
    return 'not-a-beads-project';
  }

  if (
    exitCode === 127 ||
    exitCode === -1 ||
    combinedOutput.includes('command not found') ||
    combinedOutput.includes('enoent') ||
    combinedOutput.includes('not found')
  ) {
    return 'bd-not-found';
  }

  if (combinedOutput.includes('lock')) {
    return 'lock-contention';
  }

  return 'unknown';
}

function throwBdToolFailure(
  exitCode: number,
  stdout: string,
  stderr: string,
  errorSubject: string,
): never {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  const kind = classifyBdError(exitCode, combined);
  throw new BdError(
    kind,
    errorSubject,
    combined.trim() || `exit code ${exitCode}`,
  );
}

/**
 * bd をあらかじめ組み立てた引数列で直接実行する。bd-tool-catalog(チャットエージェント向けの
 * ツール定義一覧)を経由しないため、ここで追加した引数がエージェントの利用可能ツールとして
 * 露出することはない。quick-action の逆操作(reopen/unclaim/undefer)のように、チャットツールと
 * しては公開したくない書き込みコマンドを issue-writer 層から直接叩く用途に使う。
 *
 * NOTE(bdboard-3tj): このコードベースでは runBdCommand/runBdTool は claim/close/comment/
 * defer/priority/label add-remove/reopen/unclaim/undefer/dependency add-remove など
 * 常に書き込みコマンドの実行に使われている(読み取りは runBdCommandForStdout 側)。
 * bd自体がこれら書き込みコマンドの冪等性を保証していない(特に bd comment は追記系で
 * 呼ぶたびに増える)ため、lock-contention への自動リトライは意図的に入れていない。
 * 二重実行のリスクを避けるため、ここへリトライを追加する場合はコマンドごとの
 * 冪等性を個別に確認すること。
 */
export async function runBdCommand(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  args: readonly string[],
  errorSubject: string,
  stdin?: string,
): Promise<void> {
  const result = await commandRunner.run(bdPath, args, {
    cwd: rootPath,
    timeoutMs,
    ...(stdin !== undefined ? { input: stdin } : {}),
  });

  if (result.exitCode !== 0) {
    throwBdToolFailure(
      result.exitCode,
      result.stdout,
      result.stderr,
      errorSubject,
    );
  }
}

/**
 * runBdCommand と同じ引数組み立て・エラー分類を使いつつ、成功時に stdout を呼び出し元へ
 * 返す版。bd show のような読み取りコマンドの出力をパースしたい場合に使う(undoPriority の
 * CAS チェックなど)。bd-tool-catalog を経由しない直叩き専用という位置づけも runBdCommand と
 * 同じ。
 *
 * NOTE(bdboard-3tj): 現状の呼び出し元(bd-cli-issue-writer.ts の CAS 用 bd show 読み取り、
 * bd-cli-version-reader.ts の bd version 読み取り)はすべて読み取り専用でべき等なので、
 * lock-contention エラーには数回まで自動リトライする。書き込みに転用しないこと
 * (転用するなら runBdCommand 同様リトライを外す)。
 */
export async function runBdCommandForStdout(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  args: readonly string[],
  errorSubject: string,
): Promise<string> {
  const result = await withLockContentionRetry(async () => {
    const commandResult = await commandRunner.run(bdPath, args, {
      cwd: rootPath,
      timeoutMs,
    });

    if (commandResult.exitCode !== 0) {
      throwBdToolFailure(
        commandResult.exitCode,
        commandResult.stdout,
        commandResult.stderr,
        errorSubject,
      );
    }

    return commandResult;
  });

  return result.stdout;
}

export async function runBdTool(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  toolName: string,
  rawArgs: unknown,
  errorSubject: string,
): Promise<void> {
  const built = buildBdToolArgs(toolName, rawArgs, rootPath);
  if (!built.ok) {
    throw new BdError('unknown', rootPath, built.error);
  }

  await runBdCommand(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    built.args,
    errorSubject,
    built.stdin,
  );
}
