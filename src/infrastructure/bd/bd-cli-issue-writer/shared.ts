import type { z } from 'zod';
import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { BdError } from '../../../application/ports/issue-repository.js';
import { runBdCommandForStdout } from '../bd-cli-tool-runner.js';

export type CasReadContext = 'undo' | 'update';

export async function readTicketField<TSchema, TValue>(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  schema: z.ZodType<TSchema>,
  fieldLabel: string,
  casContext: CasReadContext,
  extract: (data: TSchema) => TValue,
): Promise<TValue> {
  const stdout = await runBdCommandForStdout(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ['--readonly', '-C', rootPath, 'show', '--json', `--id=${ticketId}`],
    ticketId,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new BdError(
      'unknown',
      ticketId,
      `failed to parse bd show output while checking ${fieldLabel} for ${casContext}`,
    );
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const result = schema.safeParse(item);
  if (!result.success) {
    throw new BdError(
      'unknown',
      ticketId,
      `bd show output missing ${fieldLabel} while checking ${casContext} precondition`,
    );
  }

  return extract(result.data);
}
