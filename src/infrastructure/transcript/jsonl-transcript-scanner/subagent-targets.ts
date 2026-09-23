import path from 'node:path';
import type { BoardCache } from '../../../application/ports/board-cache.js';
import type { DirEntry, FileSystemPort } from '../../../application/ports/file-system.js';
import type { ScanTarget } from '../../../application/transcript/scan-plan.js';

export async function collectSubagentTargets(
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
