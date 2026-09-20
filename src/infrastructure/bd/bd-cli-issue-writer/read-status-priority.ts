import { z } from 'zod';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { readTicketField } from './shared.js';

// undoPriority の CAS チェック用。bd show --json の出力から priority だけ読めればよい。
const bdShowPriorityItemSchema = z.object({
  id: z.string(),
  priority: z.number().int().min(0).max(4),
});

export async function readCurrentPriority(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<number> {
  return readTicketField(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ticketId,
    bdShowPriorityItemSchema,
    'priority',
    'undo',
    (data) => data.priority,
  );
}

// reopen/undefer の CAS チェック用。bd show --json の出力から status だけ読めればよい。
// bdboard-3tw.93: bd reopen / bd undefer は前提条件を満たさなくても exit 0 の
// まま no-op するため、実コマンドを叩く前にここで現在ステータスを確認する。
const bdShowStatusItemSchema = z.object({
  id: z.string(),
  status: z.string(),
});

export async function readCurrentStatus(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
): Promise<string> {
  return readTicketField(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ticketId,
    bdShowStatusItemSchema,
    'status',
    'undo',
    (data) => data.status,
  );
}
