import os from 'node:os';
import path from 'node:path';
import type { BoardCache } from '../../../application/ports/board-cache.js';
import type { FileSystemPort } from '../../../application/ports/file-system.js';
import type { TranscriptScanner } from '../../../application/ports/transcript-scanner.js';
import { planScan } from '../../../application/transcript/scan-plan.js';
import type { SessionLink } from '../../../domain/session.js';
import { collectScanTargets } from './collect-targets.js';
import { dedupeAndSortLinks } from './link-dedupe.js';
import { processScanSlices } from './process-slices.js';
import type { ScannerDeps, ScannerOptions } from './types.js';

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

  const deps: ScannerDeps = { fs, cache, projectsDir, planOptions };

  return {
    async scan(input): Promise<readonly SessionLink[]> {
      const { projects, knownIdsByProject, now } = input;

      const targetsWithProject = await collectScanTargets(deps, projects);

      const slices = planScan(
        targetsWithProject.map((entry) => entry.target),
        deps.planOptions,
      );

      const links = await processScanSlices(
        deps,
        slices,
        targetsWithProject,
        knownIdsByProject,
        now,
      );

      return dedupeAndSortLinks(links);
    },
  };
}
