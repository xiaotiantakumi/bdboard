import os from 'node:os';
import path from 'node:path';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { DirEntry, FileSystemPort } from '../../application/ports/file-system.js';
import type { TranscriptScanner } from '../../application/ports/transcript-scanner.js';
import { normalizeSessionId } from '../../application/session/parse-session-file.js';
import { extractBeadIds } from '../../application/transcript/extract-bead-ids.js';
import { extractCompleteLines } from '../../application/transcript/extract-complete-lines.js';
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

interface TargetMeta {
  readonly previousOffset: number | undefined;
  readonly size: number;
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
      const targetMeta = new Map<string, TargetMeta>();
      for (const { target, project } of targetsWithProject) {
        filePathToProject.set(target.filePath, project);
        targetMeta.set(target.filePath, {
          previousOffset: target.previousOffset,
          size: target.size,
        });
      }

      const links: SessionLink[] = [];

      for (const slice of slices) {
        // 生 Buffer で読む。予算(budgetBytes)やファイル末尾でスライスが行の途中で
        // 切れることがあり、そこを行境界に揃えてからでないと解釈もオフセットの
        // コミットもできない(bdboard-32u / bdboard-3tw.105)。
        const chunk = await fs.readRangeBytes(slice.filePath, slice.start, slice.length);
        if (chunk === undefined) {
          continue;
        }

        const project = filePathToProject.get(slice.filePath);
        if (project === undefined) {
          continue;
        }

        const meta = targetMeta.get(slice.filePath);
        const previousOffset = meta?.previousOffset;
        const isTailRestart =
          previousOffset === undefined ||
          (meta !== undefined && previousOffset > meta.size);

        // 予算で切られた slice (EOF まで届いていない) だけは、完結した行が
        // 取れなくても前進させる。さもないと窓より長い1行でこのファイルが
        // 永久に止まり、planScan の予算切れ break で後続ファイルも飢える。
        const sliceEnd = slice.start + slice.length;
        const reachedEof = meta === undefined || sliceEnd >= meta.size;

        const { text, committedOffset } = extractCompleteLines(
          chunk,
          slice.start,
          isTailRestart,
          reachedEof ? undefined : sliceEnd,
        );

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

        // 切れた行を含む slice.newOffset ではなく、完結した行の末尾までをコミットする。
        // ここを進めすぎると、その行は二度と読まれない(usage は累積値なので恒久的な欠損)。
        cache.setTranscriptOffset(slice.filePath, committedOffset);
      }

      return dedupeAndSortLinks(links);
    },
  };
}
