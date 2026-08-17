import { join } from 'node:path';
import type { ProjectFingerprinter } from '../../application/ports/project-fingerprinter.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { Project } from '../../domain/project.js';

function statMtime(
  fs: FileSystemPort,
  path: string,
): Promise<string> {
  return fs.stat(path).then((s) => (s === undefined ? '-' : String(s.mtimeMs)));
}

function statSize(
  fs: FileSystemPort,
  path: string,
): Promise<string> {
  return fs.stat(path).then((s) => (s === undefined ? '-' : String(s.size)));
}

export function createBeadsFingerprinter(fs: FileSystemPort): ProjectFingerprinter {
  return {
    async fingerprint(project: Project): Promise<string> {
      const beadsDir = join(project.rootPath, '.beads');
      const lastTouchedPath = join(beadsDir, 'last-touched');
      const interactionsPath = join(beadsDir, 'interactions.jsonl');
      const doltPath = join(beadsDir, 'embeddeddolt');

      const [lastTouchedMtime, lastTouchedContent, interactionsSize, interactionsMtime, doltMtime] =
        await Promise.all([
          statMtime(fs, lastTouchedPath),
          fs.readFile(lastTouchedPath).then((c) => c ?? ''),
          statSize(fs, interactionsPath),
          statMtime(fs, interactionsPath),
          statMtime(fs, doltPath),
        ]);

      return `last-touched:${lastTouchedMtime}:${lastTouchedContent}|interactions:${interactionsSize}:${interactionsMtime}|dolt:${doltMtime}`;
    },
  };
}
