import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { PriorityConflictError } from '../../../application/ports/issue-writer.js';
import { runBdTool } from '../bd-cli-tool-runner.js';
import { readCurrentPriority } from './read-status-priority.js';

export async function defer(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  untilDate: string,
): Promise<void> {
  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_defer',
    { id: ticketId, untilDate },
    ticketId,
  );
}

export async function setPriority(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  priority: number,
): Promise<void> {
  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_priority',
    { id: ticketId, priority },
    ticketId,
  );
}

// bd-tool-catalog 経由でチャットエージェントと同じ bd label add/remove を叩く。
export async function addLabel(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  label: string,
): Promise<void> {
  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_label_add',
    { id: ticketId, label },
    ticketId,
  );
}

export async function removeLabel(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  label: string,
): Promise<void> {
  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_label_remove',
    { id: ticketId, label },
    ticketId,
  );
}

// bdboard-3tw.82: bd に --if-priority が無いため、read-then-write で CAS を近似する。
// 現在値を bd show で読み、Undo が想定している「クイックアクション実行直後の値」と
// 一致するときだけ setPriority を叩く。不一致なら書き込まず PriorityConflictError。
export async function undoPriority(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  expectedCurrentPriority: number,
  previousPriority: number,
): Promise<void> {
  const actualPriority = await readCurrentPriority(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ticketId,
  );

  if (actualPriority !== expectedCurrentPriority) {
    throw new PriorityConflictError(
      ticketId,
      expectedCurrentPriority,
      actualPriority,
    );
  }

  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_priority',
    { id: ticketId, priority: previousPriority },
    ticketId,
  );
}
