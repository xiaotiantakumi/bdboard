import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { StatusConflictError } from '../../../application/ports/issue-writer.js';
import { runBdCommand, runBdTool } from '../bd-cli-tool-runner.js';
import { withLockContentionRetry } from '../bd-retry.js';
import { readCurrentStatus } from './read-status-priority.js';

// bdboard-miqg: claim は「同一アクターの再 claim は exit 0 の真の no-op」
// (bdboard-pkr6.26 で実測・bd-cli-issue-writer.test.ts に固定) であることが
// 分かっている冪等な書き込みなので、一時的な .beads lock-contention に限り
// 数回リトライする(runBdCommand 全体には適用しない方針は
// bd-cli-tool-runner.ts の doc コメントの通り — 他の非冪等な書き込みコマンドを
// 巻き込まないよう、この呼び出しだけ個別に対象へ含める)。
// 「別アクターが既に保持している」という真の排他違反は classifyBdError で
// kind='unknown' になり(bd-cli-issue-writer.test.ts で固定済み)、
// withLockContentionRetry は kind='lock-contention' のときしかリトライしない
// ため対象外のまま即座に失敗する。
export async function claim(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<void> {
  await withLockContentionRetry(() =>
    runBdTool(
      commandRunner,
      bdPath,
      timeoutMs,
      rootPath,
      'bd_claim',
      { id: ticketId },
      ticketId,
    ),
  );
}

export async function close(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  reason?: string,
): Promise<void> {
  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_close',
    {
      id: ticketId,
      ...(reason !== undefined ? { reason } : {}),
    },
    ticketId,
  );
}

// 以下 3 関数はクイックアクションの逆操作(undo)専用。bd-tool-catalog(チャット
// エージェントに公開するツール一覧)を経由せず bd を直接呼ぶ。理由は
// bd-cli-tool-runner.ts の runBdCommand の doc コメントを参照。
// bdboard-3tw.93: `bd reopen` is exit-0-and-no-op when the ticket isn't
// currently closed (it prints something like 'is not closed; nothing to
// do' to stderr but does not fail) — the old implementation trusted the
// exit code and reported a fake success to the UI. Read-then-write CAS,
// same shape as undoPriority (bdboard-3tw.82): check the current status
// first and refuse to write if it has drifted away from 'closed'.
export async function reopen(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<void> {
  const actualStatus = await readCurrentStatus(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ticketId,
  );

  if (actualStatus !== 'closed') {
    throw new StatusConflictError(ticketId, 'closed', actualStatus);
  }

  await runBdCommand(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['-C', rootPath, 'reopen', ticketId],
    ticketId,
  );
}

export async function unclaim(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<void> {
  await runBdCommand(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['-C', rootPath, 'unclaim', ticketId],
    ticketId,
  );
}

export async function undefer(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<void> {
  // bdboard-3tw.82: 以前は `update --defer ''` という素朴なフィールド更新だったが、
  // これはステータスの前提条件を明示的にチェックしない未文書化の副作用に頼っていた。
  // 専用の `bd undefer` サブコマンドへ切り替えた。
  //
  // bdboard-3tw.93: ただし `bd undefer` のガードは exit 0 のまま no-op するだけで
  // エラーにはならない(「reopen/unclaim と同じ形の built-in ガード」という以前の
  // コメントは、無言で上書きしないという意味では正しかったが、エラーを返すという
  // 意味では誤りだった)。undoPriority(bdboard-3tw.82)と同じ read-then-write CAS で
  // 対処する: 呼び出し前に現在ステータスを確認し、'deferred' から動いていれば
  // 書き込まずに StatusConflictError を投げる。
  const actualStatus = await readCurrentStatus(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ticketId,
  );

  if (actualStatus !== 'deferred') {
    throw new StatusConflictError(ticketId, 'deferred', actualStatus);
  }

  await runBdCommand(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['-C', rootPath, 'undefer', ticketId],
    ticketId,
  );
}
