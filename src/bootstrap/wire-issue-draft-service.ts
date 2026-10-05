/** bdboard-4y8q.6.3: 下書き service と起動時掃除を共通配線する。 */
import { randomBytes } from 'node:crypto';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import type { ApplicationVersionProvider } from '../application/ports/application-version.js';
import type { DraftEnvInfo } from '../domain/issue-draft.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { resolveIssueDraftsDir } from '../infrastructure/fs/resolve-issue-drafts-dir.js';

export interface WireIssueDraftServiceDeps {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * サーバーが埋める版の元 (手書きの下書き 4y8q.6.7 の envInfo)。必須にしてある: main.ts は作ったサービスを
   * wireIssueReports へ渡すので、ここで渡し忘れると手書きの下書きの版が黙って 'unknown' になる。
   */
  readonly applicationVersion: ApplicationVersionProvider;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

/** サーバーが埋める版 (bdboard・OS・Node)。手書きの下書き (4y8q.6.7) と本体エラー (4y8q.6.3) の共通の元。 */
export function serverEnvInfo(applicationVersion: ApplicationVersionProvider): () => DraftEnvInfo {
  return () => ({ bdboardVersion: applicationVersion.getVersion(), os: process.platform, nodeVersion: process.version });
}

export function wireIssueDraftService(deps: WireIssueDraftServiceDeps): IssueDraftService {
  const log = deps.log ?? console.log;
  const draftsDir = resolveIssueDraftsDir(deps.repoRoot, deps.env);
  const now = deps.now ?? (() => new Date());
  const service = createIssueDraftService({
    storage: createFsIssueDraftStorage(draftsDir),
    now,
    // 添付画像と同じ採番規約: <epochMs>-<16桁hex> (ソート可能・衝突耐性・パスとして安全)。
    newId: () => `${Date.now()}-${randomBytes(8).toString('hex')}`,
    // 手書きの下書きの envInfo はサーバーが埋める (画面からは受けない)。
    envInfo: serverEnvInfo(deps.applicationVersion),
  });
  void service.pruneOnStart().catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    log(`issue draft prune at start failed (${typeof code === 'string' ? code : 'unknown'})`);
  });
  log(`Issue report drafts: storing under ${draftsDir}`);
  return service;
}
