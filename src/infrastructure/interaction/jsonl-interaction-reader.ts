import path from 'node:path';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { InteractionReader } from '../../application/ports/interaction-reader.js';
import { parseInteractions } from '../../application/interaction/parse-interactions.js';
import { extractCompleteLines } from '../../application/transcript/extract-complete-lines.js';
import { planScan, type ScanTarget } from '../../application/transcript/scan-plan.js';
import type { InteractionRecord } from '../../domain/interaction.js';

interface ReaderOptions {
  readonly initialTailBytes?: number;
  readonly budgetBytes?: number;
}

interface TargetMeta {
  readonly previousOffset: number | undefined;
  readonly size: number;
}

export function createJsonlInteractionReader(
  fs: FileSystemPort,
  cache: BoardCache,
  options?: ReaderOptions,
): InteractionReader {
  const planOptions =
    options?.initialTailBytes !== undefined || options?.budgetBytes !== undefined
      ? {
          ...(options.initialTailBytes !== undefined
            ? { initialTailBytes: options.initialTailBytes }
            : {}),
          ...(options.budgetBytes !== undefined ? { budgetBytes: options.budgetBytes } : {}),
        }
      : undefined;

  return {
    async read(input): Promise<readonly InteractionRecord[]> {
      const { projects } = input;
      const targets: ScanTarget[] = [];
      const targetMeta = new Map<string, TargetMeta>();

      for (const project of projects) {
        const filePath = path.join(project.rootPath, '.beads', 'interactions.jsonl');
        try {
          const fileStat = await fs.stat(filePath);
          if (fileStat === undefined) {
            continue;
          }

          const previousOffset = cache.getTranscriptOffset(filePath);
          targetMeta.set(filePath, { previousOffset, size: fileStat.size });
          targets.push({
            filePath,
            sessionId: 'interactions',
            size: fileStat.size,
            previousOffset,
          });
        } catch {
          continue;
        }
      }

      const slices = planScan(targets, planOptions);
      const allRecords: InteractionRecord[] = [];

      for (const slice of slices) {
        let chunk: Buffer | undefined;
        try {
          chunk = await fs.readRangeBytes(slice.filePath, slice.start, slice.length);
        } catch {
          continue;
        }
        if (chunk === undefined) {
          continue;
        }

        const meta = targetMeta.get(slice.filePath);
        const previousOffset = meta?.previousOffset;
        const isTailRestart =
          previousOffset === undefined ||
          (meta !== undefined && previousOffset > meta.size);

        // scanner と同じ理由で、EOF まで届いていない slice だけ強制前進させる
        // (bdboard-32u)。
        const sliceEnd = slice.start + slice.length;
        const reachedEof = meta === undefined || sliceEnd >= meta.size;

        const { text: completeText, committedOffset } = extractCompleteLines(
          chunk,
          slice.start,
          isTailRestart,
          reachedEof ? undefined : sliceEnd,
        );

        const records = parseInteractions(completeText);
        if (records.length > 0) {
          cache.appendInteractions(records);
        }

        // transcript_offsets は file_path→byte_offset の汎用マップなので、
        // interactions.jsonl の増分 tail も同じ get/setTranscriptOffset を再利用する。
        cache.setTranscriptOffset(slice.filePath, committedOffset);
        allRecords.push(...records);
      }

      return allRecords;
    },
  };
}
