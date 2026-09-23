import { extractBeadIds } from '../../../application/transcript/extract-bead-ids.js';
import { extractCompleteLines } from '../../../application/transcript/extract-complete-lines.js';
import { extractUsageTotals } from '../../../application/transcript/extract-usage.js';
import type { ScanSlice } from '../../../application/transcript/scan-plan.js';
import type { Project } from '../../../domain/project.js';
import type { SessionLink } from '../../../domain/session.js';
import type { ScannerDeps, TargetMeta, TargetWithProject } from './types.js';

/**
 * createJsonlTranscriptScanner() の scan() が持っていた slice 処理ループを、クロージャの
 * 代わりに ScannerDeps を明示引数として受け取る関数へ移した (挙動は変えていない)。
 */
export async function processScanSlices(
  deps: ScannerDeps,
  slices: readonly ScanSlice[],
  targetsWithProject: readonly TargetWithProject[],
  knownIdsByProject: ReadonlyMap<string, ReadonlySet<string>>,
  now: Date,
): Promise<readonly SessionLink[]> {
  const { fs, cache } = deps;

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

  return links;
}
