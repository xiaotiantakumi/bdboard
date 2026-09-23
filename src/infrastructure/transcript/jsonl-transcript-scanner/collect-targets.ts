import path from 'node:path';
import type { DirEntry } from '../../../application/ports/file-system.js';
import { normalizeSessionId } from '../../../application/session/parse-session-file.js';
import type { Project } from '../../../domain/project.js';
import { findProjectForDirName } from '../transcript-dir-matching.js';
import { sessionIdFromFileName } from './session-id.js';
import { collectSubagentTargets } from './subagent-targets.js';
import type { ScannerDeps, TargetWithProject } from './types.js';

/**
 * createJsonlTranscriptScanner() の scan() が持っていた走査対象収集ループを、クロージャの
 * 代わりに ScannerDeps を明示引数として受け取る関数へ移した (挙動は変えていない)。
 */
export async function collectScanTargets(
  deps: ScannerDeps,
  projects: readonly Project[],
): Promise<readonly TargetWithProject[]> {
  const { fs, cache, projectsDir } = deps;

  let topEntries: readonly DirEntry[];
  try {
    topEntries = await fs.readDir(projectsDir);
  } catch {
    return [];
  }

  const targetsWithProject: TargetWithProject[] = [];

  for (const entry of topEntries) {
    if (!entry.isDirectory) {
      continue;
    }

    const dirName = entry.name;
    const project = findProjectForDirName(dirName, projects);
    if (project === undefined) {
      continue;
    }

    const dirPath = path.join(projectsDir, dirName);
    let fileEntries: readonly DirEntry[];
    try {
      fileEntries = await fs.readDir(dirPath);
    } catch {
      continue;
    }

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isDirectory && fileEntry.name.endsWith('.jsonl')) {
        const filePath = path.join(dirPath, fileEntry.name);
        const fileStat = await fs.stat(filePath);
        if (fileStat === undefined) {
          continue;
        }

        targetsWithProject.push({
          project,
          target: {
            filePath,
            sessionId: sessionIdFromFileName(fileEntry.name),
            size: fileStat.size,
            previousOffset: cache.getTranscriptOffset(filePath),
          },
        });
        continue;
      }

      if (fileEntry.isDirectory) {
        const sessionDirPath = path.join(dirPath, fileEntry.name);
        const parentSessionId = normalizeSessionId(fileEntry.name);
        const subagentTargets = await collectSubagentTargets(
          fs,
          cache,
          sessionDirPath,
          parentSessionId,
        );
        for (const target of subagentTargets) {
          targetsWithProject.push({ project, target });
        }
      }
    }
  }

  return targetsWithProject;
}
