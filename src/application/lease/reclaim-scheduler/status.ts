// bdboard-z7xp: create-scheduler.ts から、statusByProjectId の get-or-create
// (ensureProjectStatus) と MutableProjectStatus -> ReclaimProjectStatus の
// スナップショット変換 (toProjectStatusSnapshot) を切り出したモジュール
// (挙動変更ゼロ)。create-scheduler.ts からの cross-module use のため export
// を付けている。公開エクスポート面には含めない — 入口の reclaim-scheduler.ts
// はこれらを re-export しない。ensureProjectStatus は渡された Map を書き換える
// ため、副作用の無い意味での「純関数」ではない点に留意。
import type { MutableProjectStatus, ReclaimProjectStatus } from './types.js';

export function ensureProjectStatus(
  statusByProjectId: Map<string, MutableProjectStatus>,
  projectId: string,
): MutableProjectStatus {
  let entry = statusByProjectId.get(projectId);
  if (entry === undefined) {
    entry = {
      projectId,
      lastRunAt: null,
      reclaimedCount: null,
      reclaimedCountUnknown: false,
      rawSummary: null,
      lastError: null,
    };
    statusByProjectId.set(projectId, entry);
  }
  return entry;
}

export function toProjectStatusSnapshot(entry: MutableProjectStatus): ReclaimProjectStatus {
  return {
    projectId: entry.projectId,
    lastRunAt: entry.lastRunAt?.toISOString() ?? null,
    reclaimedCount: entry.reclaimedCount,
    reclaimedCountUnknown: entry.reclaimedCountUnknown,
    rawSummary: entry.rawSummary,
    lastError: entry.lastError,
  };
}
