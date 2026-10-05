/** bdboard-4y8q.6.3: 下書き service と起動時掃除を共通配線する。 */
import { randomBytes } from 'node:crypto';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { resolveIssueDraftsDir } from '../infrastructure/fs/resolve-issue-drafts-dir.js';

export interface WireIssueDraftServiceDeps {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export function wireIssueDraftService(deps: WireIssueDraftServiceDeps): IssueDraftService {
  const log = deps.log ?? console.log;
  const draftsDir = resolveIssueDraftsDir(deps.repoRoot, deps.env);
  const now = deps.now ?? (() => new Date());
  const service = createIssueDraftService({
    storage: createFsIssueDraftStorage(draftsDir), now,
    newId: () => `${Date.now()}-${randomBytes(8).toString('hex')}`,
  });
  void service.pruneOnStart().catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    log(`issue draft prune at start failed (${typeof code === 'string' ? code : 'unknown'})`);
  });
  log(`Issue report drafts: storing under ${draftsDir}`);
  return service;
}
