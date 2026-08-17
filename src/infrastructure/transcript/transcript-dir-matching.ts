import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import { encodeCwdForTranscript } from '../../application/session/parse-session-file.js';

export function encodedMatchesDirName(dirName: string, encoded: string): boolean {
  return dirName === encoded || dirName.startsWith(`${encoded}-`);
}

export function findProjectForDirName(
  dirName: string,
  projects: readonly Project[],
): Project | undefined {
  let best: Project | undefined;
  let bestEncodedLength = -1;

  for (const project of projects) {
    const pathsToEncode = [project.rootPath, ...project.aliasPaths];
    let projectBestEncodedLength = -1;

    for (const pathToEncode of pathsToEncode) {
      const encoded = encodeCwdForTranscript(pathToEncode);
      if (!encodedMatchesDirName(dirName, encoded)) continue;
      if (encoded.length > projectBestEncodedLength) {
        projectBestEncodedLength = encoded.length;
      }
    }

    if (projectBestEncodedLength < 0) continue;
    if (projectBestEncodedLength > bestEncodedLength) {
      best = project;
      bestEncodedLength = projectBestEncodedLength;
    } else if (
      projectBestEncodedLength === bestEncodedLength &&
      best !== undefined &&
      compareStrings(project.id, best.id) < 0
    ) {
      best = project;
    }
  }

  return best;
}
