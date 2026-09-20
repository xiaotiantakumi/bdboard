/**
 * bdboard-sso1.14: src/main.ts (composition root) からセッション生死・
 * transcript/interaction 走査の組み立てを切り出したもの (move only,
 * 挙動変更ゼロ)。
 *
 * 「同期的な組み立て」(構築時の副作用は transcriptLinkTracker の
 * hydrateFromCache + ログだけ) と「起動時の初回取得」(非同期・ps/lsof や
 * ファイル走査を伴う) を分けて export する。main.ts 側が後者をいつ await
 * するかで、board の初期リフレッシュとの起動時副作用の相対順序 (元実装:
 * board の初期リフレッシュ完了 → sessions の初回取得) を保つ。
 */
import type { BoardCache } from '../application/ports/board-cache.js';
import type { EventHub } from '../interface/sse/event-hub.js';
import type { PlatformSupport } from '../domain/platform-support.js';
import {
  createClaudeSessionRegistry,
  createJsonlTranscriptScanner,
  createFsChatSessionDiscovery,
  createJsonlInteractionReader,
  createSessionTailReader,
  NodeFileSystem,
  NodeProcessProbe,
} from '../infrastructure/index.js';
import { createTranscriptLinkTracker } from '../application/board/transcript-link-tracker.js';
import { createSessionLivenessTracker } from '../application/board/session-liveness-tracker.js';

export interface WireBoardSessionsDeps {
  readonly fsPort: InstanceType<typeof NodeFileSystem>;
  readonly cache: BoardCache;
  readonly events: EventHub;
  readonly log?: (message: string) => void;
}

export function createBoardSessionServices(deps: WireBoardSessionsDeps) {
  const log = deps.log ?? console.log;
  const sessionRegistry = createClaudeSessionRegistry(deps.fsPort, new NodeProcessProbe());
  const transcriptScanner = createJsonlTranscriptScanner(deps.fsPort, deps.cache);
  const chatSessionDiscovery = createFsChatSessionDiscovery(deps.fsPort);
  const interactionReader = createJsonlInteractionReader(deps.fsPort, deps.cache);
  const sessionTailReader = createSessionTailReader(deps.fsPort);

  // bdboard-sso1.9: transcript link のインメモリ集計 (旧 transcriptLinkMap 一式) は
  // application/board/transcript-link-tracker.ts へ移動 (move only)。
  const transcriptLinkTracker = createTranscriptLinkTracker({ cache: deps.cache });

  // 起動時に SQLite の session_links から transcriptLinkTracker を再構築する。走査位置
  // (transcript_offsets)は既に永続化されているため、これをやらないと再起動のたびに
  // 過去のリンクが読み直されずに失われる(bdboard-3tw.83)。
  transcriptLinkTracker.hydrateFromCache();
  log(`Hydrated transcript links from cache: count=${transcriptLinkTracker.size()}`);

  let transcriptScanRunning = false;

  // bdboard-sso1.9: セッション生死の定期取得・差分検知 (旧 refreshSessions 一式) は
  // application/board/session-liveness-tracker.ts へ移動 (move only)。
  const sessionLivenessTracker = createSessionLivenessTracker({
    registry: sessionRegistry,
    now: () => new Date(),
    publishSessionDied: (payload) => {
      deps.events.publish({ name: 'notification', data: payload });
    },
    publishSessionsChanged: (data) => {
      deps.events.publish({ name: 'session.changed', data });
    },
  });

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
    sessionRegistry,
    transcriptScanner,
    chatSessionDiscovery,
    interactionReader,
    sessionTailReader,
    transcriptLinkTracker,
    sessionLivenessTracker,
    runTranscriptScan,
  };
}

export type BoardSessionServices = ReturnType<typeof createBoardSessionServices>;

/** main() の `sessionDiscoverySupported ? await sessionLivenessTracker.refresh() ... ` 相当。 */
export async function runInitialSessionsFetch(
  services: Pick<BoardSessionServices, 'sessionLivenessTracker'>,
  platformSupport: PlatformSupport,
  sessionDiscoverySupported: boolean,
  log: (message: string) => void = console.log,
): Promise<void> {
  if (sessionDiscoverySupported) {
    await services.sessionLivenessTracker.refresh();
    log(
      `Initial sessions: total=${services.sessionLivenessTracker.current().length} alive=${services.sessionLivenessTracker.current().filter((session) => session.alive).length}`,
    );
  } else {
    // ps/lsof が無い環境で回しても毎周期失敗するだけなので、走らせない
    // (bdboard-70z.9)。UI 側は /api/platform-support を見て理由を出す。
    log(`Sessions: disabled on ${platformSupport.platform} (session discovery needs ps/lsof)`);
  }
}

/** main() の transcriptIntervalMs>0 ブロック相当 (初回スキャン + setInterval)。 */
export async function startTranscriptInterval(
  services: Pick<BoardSessionServices, 'transcriptScanner' | 'transcriptLinkTracker' | 'interactionReader' | 'runTranscriptScan'>,
  deps: { readonly cache: BoardCache; readonly transcriptIntervalMs: number },
  log: (message: string) => void = console.log,
  logError: (message: string) => void = console.error,
): Promise<ReturnType<typeof setInterval> | undefined> {
  if (deps.transcriptIntervalMs <= 0) {
    return undefined;
  }

  try {
    const initialLinks = await services.transcriptScanner.scan({
      projects: deps.cache.listProjects().map((entry) => entry.project),
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
      projects: deps.cache.listProjects().map((entry) => entry.project),
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

/** main() の sessionIntervalTimer 相当。 */
export function startSessionInterval(
  services: Pick<BoardSessionServices, 'sessionLivenessTracker'>,
  sessionDiscoverySupported: boolean,
  sessionIntervalMs: number,
): ReturnType<typeof setInterval> | null {
  return sessionDiscoverySupported
    ? setInterval(() => {
        void services.sessionLivenessTracker.refresh();
      }, sessionIntervalMs)
    : null;
}
