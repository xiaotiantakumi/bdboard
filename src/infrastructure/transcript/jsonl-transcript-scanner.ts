import os from 'node:os';
import path from 'node:path';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { DirEntry, FileSystemPort } from '../../application/ports/file-system.js';
import type { TranscriptScanner } from '../../application/ports/transcript-scanner.js';
import { normalizeSessionId } from '../../application/session/parse-session-file.js';
import { extractBeadIds } from '../../application/transcript/extract-bead-ids.js';
import { extractUsageTotals } from '../../application/transcript/extract-usage.js';
import { planScan, type ScanTarget } from '../../application/transcript/scan-plan.js';
import { compareStrings } from '../../domain/compare.js';
import type { Project } from '../../domain/project.js';
import type { SessionLink } from '../../domain/session.js';
import { findProjectForDirName } from './transcript-dir-matching.js';

interface ScannerOptions {
  readonly projectsDir?: string;
  readonly initialTailBytes?: number;
  readonly budgetBytes?: number;
}

interface TargetWithProject {
  readonly target: ScanTarget;
  readonly project: Project;
}

function sessionIdFromFileName(fileName: string): string {
  const base = fileName.endsWith('.jsonl')
    ? fileName.slice(0, -'.jsonl'.length)
    : fileName;
  return normalizeSessionId(base);
}

async function collectSubagentTargets(
  fs: FileSystemPort,
  cache: BoardCache,
  sessionDirPath: string,
  parentSessionId: string,
): Promise<readonly ScanTarget[]> {
  const subagentsDir = path.join(sessionDirPath, 'subagents');
  let subagentEntries: readonly DirEntry[];
  try {
    subagentEntries = await fs.readDir(subagentsDir);
  } catch {
    return [];
  }

  const targets: ScanTarget[] = [];
  for (const entry of subagentEntries) {
    if (entry.isDirectory || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const filePath = path.join(subagentsDir, entry.name);
    const fileStat = await fs.stat(filePath);
    if (fileStat === undefined) {
      continue;
    }

    targets.push({
      filePath,
      sessionId: parentSessionId,
      size: fileStat.size,
      previousOffset: cache.getTranscriptOffset(filePath),
    });
  }

  return targets;
}

function dedupeAndSortLinks(links: readonly SessionLink[]): readonly SessionLink[] {
  const map = new Map<string, SessionLink>();
  for (const link of links) {
    const key = `${link.ticketId}\0${link.sessionId}`;
    map.set(key, link);
  }

  return [...map.values()].sort((a, b) => {
    const ticketCmp = compareStrings(a.ticketId, b.ticketId);
    if (ticketCmp !== 0) {
      return ticketCmp;
    }
    return compareStrings(a.sessionId, b.sessionId);
  });
}

export function createJsonlTranscriptScanner(
  fs: FileSystemPort,
  cache: BoardCache,
  options?: ScannerOptions,
): TranscriptScanner {
  const projectsDir =
    options?.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
  const planOptions =
    options?.initialTailBytes !== undefined || options?.budgetBytes !== undefined
      ? {
          ...(options.initialTailBytes !== undefined
            ? { initialTailBytes: options.initialTailBytes }
            : {}),
          ...(options.budgetBytes !== undefined
            ? { budgetBytes: options.budgetBytes }
            : {}),
        }
      : undefined;

  return {
    async scan(input): Promise<readonly SessionLink[]> {
      const { projects, knownIdsByProject, now } = input;

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

      const slices = planScan(
        targetsWithProject.map((entry) => entry.target),
        planOptions,
      );

      const filePathToProject = new Map<string, Project>();
      for (const { target, project } of targetsWithProject) {
        filePathToProject.set(target.filePath, project);
      }

      const links: SessionLink[] = [];

      for (const slice of slices) {
        const text = await fs.readRange(slice.filePath, slice.start, slice.length);
        if (text === undefined) {
          continue;
        }

        const project = filePathToProject.get(slice.filePath);
        if (project === undefined) {
          continue;
        }

        const knownIds = knownIdsByProject.get(project.id) ?? new Set<string>();
        const ticketIds = extractBeadIds(text, project.prefixes, knownIds);

        for (const ticketId of ticketIds) {
          links.push({
            ticketId,
            sessionId: slice.sessionId,
            source: 'transcript',
            confidence: 0.6,
            observedAt: now,
          });
        }

        for (const usage of extractUsageTotals(text)) {
          cache.addSessionUsage(slice.sessionId, usage);
        }

        cache.setTranscriptOffset(slice.filePath, slice.newOffset);
      }

      return dedupeAndSortLinks(links);
    },
  };
}
