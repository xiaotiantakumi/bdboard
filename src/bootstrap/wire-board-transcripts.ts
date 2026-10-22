/**
 * bdboard-sso1.14: src/main.ts (composition root) から transcript/interaction
 * 走査の組み立てを切り出したもの。bdboard-i9g4.9 でセッション一覧 (生死判定・
 * tail・chat adopt) を撤去し、ticket 詳細の token usage と activity タイムラインが
 * 使う transcript link / interaction の走査だけを残した。
 *
 * 「同期的な組み立て」(構築時の副作用は transcriptLinkTracker の
 * hydrateFromCache + ログだけ) と「起動時の初回取得」(非同期・ファイル走査を伴う)
 * を分けて export する。
 */
import type { BoardCache } from '../application/ports/board-cache.js';
import type { EventHub } from '../interface/sse/event-hub.js';
import {
  createJsonlTranscriptScanner,
  createJsonlInteractionReader,
  NodeFileSystem,
} from '../infrastructure/index.js';
import { createTranscriptLinkTracker } from '../application/board/transcript-link-tracker.js';
import { readProjectRefs } from '../application/board/read-cached-projects.js';

export interface WireBoardTranscriptsDeps {
  readonly fsPort: InstanceType<typeof NodeFileSystem>;
  readonly cache: BoardCache;
  readonly events: EventHub;
  readonly log?: (message: string) => void;
}

export function createBoardTranscriptServices(deps: WireBoardTranscriptsDeps) {
  const log = deps.log ?? console.log;
  const transcriptScanner = createJsonlTranscriptScanner(deps.fsPort, deps.cache);
  const interactionReader = createJsonlInteractionReader(deps.fsPort, deps.cache);

  // bdboard-sso1.9: transcript link のインメモリ集計は
  // application/board/transcript-link-tracker.ts へ移動 (move only)。
  const transcriptLinkTracker = createTranscriptLinkTracker({ cache: deps.cache });

  // 起動時に SQLite の session_links から transcriptLinkTracker を再構築する。走査位置
  // (transcript_offsets)は既に永続化されているため、これをやらないと再起動のたびに
  // 過去のリンクが読み直されずに失われる(bdboard-3tw.83)。
  transcriptLinkTracker.hydrateFromCache();
  log(`Hydrated transcript links from cache: count=${transcriptLinkTracker.size()}`);

  let transcriptScanRunning = false;

  const runTranscriptScan = async (): Promise<void> => {
    if (transcriptScanRunning) {
      return;
    }

    transcriptScanRunning = true;

    try {
      const entries = deps.cache.listProjects();
      const projects = entries.map((entry) => entry.project);
      const knownIdsByProject = new Map(
        entries.map((entry) => [
          entry.project.id,
          new Set(entry.tickets.map((ticket) => ticket.id)),
        ]),
      );

      const newLinks = await transcriptScanner.scan({
        projects,
        knownIdsByProject,
        now: new Date(),
      });

      const hasNew = transcriptLinkTracker.merge(newLinks);
      if (hasNew) {
        deps.events.publish({
          name: 'board.changed',
          data: { refreshed: [], reused: [], removed: [] },
        });
      }

      const newInteractions = await interactionReader.read({ projects });
      if (newInteractions.length > 0) {
        console.log(`Interaction read: records=${newInteractions.length}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`Transcript scan error: ${detail}`);
    } finally {
      transcriptScanRunning = false;
    }
  };

  return {
    transcriptScanner,
    interactionReader,
    transcriptLinkTracker,
    runTranscriptScan,
  };
}

export type BoardTranscriptServices = ReturnType<typeof createBoardTranscriptServices>;

/** main() の transcriptIntervalMs>0 ブロック相当 (初回スキャン + setInterval)。 */
export async function startTranscriptInterval(
  services: Pick<BoardTranscriptServices, 'transcriptScanner' | 'transcriptLinkTracker' | 'interactionReader' | 'runTranscriptScan'>,
  deps: { readonly cache: BoardCache; readonly transcriptIntervalMs: number },
  log: (message: string) => void = console.log,
  logError: (message: string) => void = console.error,
): Promise<ReturnType<typeof setInterval> | undefined> {
  if (deps.transcriptIntervalMs <= 0) {
    return undefined;
  }

  try {
    const initialLinks = await services.transcriptScanner.scan({
      projects: readProjectRefs(deps.cache),
      knownIdsByProject: new Map(
        deps.cache.listProjects().map((entry) => [
          entry.project.id,
          new Set(entry.tickets.map((ticket) => ticket.id)),
        ]),
      ),
      now: new Date(),
    });
    services.transcriptLinkTracker.merge(initialLinks);
    log(`Initial transcript scan: links=${initialLinks.length}`);

    const initialInteractions = await services.interactionReader.read({
      projects: readProjectRefs(deps.cache),
    });
    log(`Initial interaction read: records=${initialInteractions.length}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logError(`Initial transcript scan error: ${detail}`);
  }

  return setInterval(() => {
    void services.runTranscriptScan();
  }, deps.transcriptIntervalMs);
}
