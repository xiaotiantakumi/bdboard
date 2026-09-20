import fs from 'node:fs';
import path from 'node:path';
import { appendGitignoreEntries, GITIGNORE_FILENAME } from '../../../domain/harness-path.js';

export async function updateGitignoreForPack(
  projectRootPath: string,
  packName: string,
): Promise<void> {
  const gitignorePath = path.join(projectRootPath, GITIGNORE_FILENAME);
  let existingContent = '';

  try {
    existingContent = await fs.promises.readFile(gitignorePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  const updatedContent = appendGitignoreEntries(existingContent, packName);
  if (updatedContent === existingContent) {
    return;
  }

  await fs.promises.writeFile(gitignorePath, updatedContent, 'utf8');
}
