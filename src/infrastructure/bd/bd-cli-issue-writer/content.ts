import type { CommandRunner } from '../../../application/ports/command-runner.js';
import { ContentConflictError } from '../../../application/ports/issue-writer.js';
import { runBdCommand, runBdTool } from '../bd-cli-tool-runner.js';
import { readCurrentDescription, readCurrentTitle } from './read-content.js';

export async function addComment(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  text: string,
): Promise<void> {
  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_comment',
    { id: ticketId, text },
    ticketId,
  );
}

export async function updateTitle(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  title: string,
  expectedCurrentTitle: string,
): Promise<void> {
  const actualTitle = await readCurrentTitle(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ticketId,
  );

  if (actualTitle !== expectedCurrentTitle) {
    throw new ContentConflictError(
      ticketId,
      'title',
      expectedCurrentTitle,
      actualTitle,
    );
  }

  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_update_title',
    { id: ticketId, title },
    ticketId,
  );
}

export async function updateDescription(
  commandRunner: CommandRunner,
  bdPath: string,
  timeoutMs: number,
  rootPath: string,
  ticketId: string,
  description: string,
  expectedCurrentDescription: string,
): Promise<void> {
  const actualDescription = await readCurrentDescription(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    ticketId,
  );

  if (actualDescription !== expectedCurrentDescription) {
    throw new ContentConflictError(
      ticketId,
      'description',
      expectedCurrentDescription,
      actualDescription,
    );
  }

  if (description.length === 0) {
    // bd-tool-catalog の bd_update_description は min(1) だが、REST API は
    // description クリア(空文字)を許容する。--stdin に空文字を渡すと
    // --allow-empty-description が必要になるため、インライン --description "" を使う。
    await runBdCommand(
      commandRunner,
      bdPath,
      timeoutMs,
      rootPath,
      ['-C', rootPath, 'update', ticketId, '--description', ''],
      ticketId,
    );
    return;
  }

  await runBdTool(
    commandRunner,
    bdPath,
    timeoutMs,
    rootPath,
    'bd_update_description',
    { id: ticketId, description },
    ticketId,
  );
}
