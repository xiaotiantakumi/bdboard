import { z } from 'zod';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { readTicketField } from './shared.js';

// updateTitle/updateDescription の CAS チェック用。bd show --json の出力から
// title / description だけ読めればよい。
const bdShowTitleItemSchema = z.object({
  id: z.string(),
  title: z.string(),
});

const bdShowDescriptionItemSchema = z.object({
  id: z.string(),
  description: z.string().nullish(),
});

export async function readCurrentTitle(
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
    bdShowTitleItemSchema,
    'title',
    'update',
    (data) => data.title,
  );
}

export async function readCurrentDescription(
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
    bdShowDescriptionItemSchema,
    'description',
    'update',
    (data) => data.description ?? '',
  );
}
