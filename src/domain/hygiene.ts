// src/domain/hygiene.ts は bdboard-sso1.15 でモジュール分割された。実体は ./hygiene/ 配下。
// このファイルは import 側 (routes・テスト) を書き換えないための re-export 入口としてのみ
// 残す。挙動・型は一切変えていない (移動のみ)。
//
// 分割前は集約関数 checkHygiene と同じファイルに全シンボルがあり、多くの検出関数は
// 非公開 (export なし) だった。分割後は集約関数がサブモジュールの検出関数を import する
// 必要があるためサブモジュール間では export を付けているが、ここで `export *` を使うと
// 元は非公開だった検出関数まで公開エクスポート面に漏れてしまう。よって公開面は分割前の
// export 一覧のとおり名前を明示して re-export する (dto.ts の分割 (PR #540) と同じ方式。
// 回帰ガードは hygiene.exportSurface.test.ts / hygiene-type-export-surface.check.ts)。
export type { HygieneThresholds, HygieneThresholdsOverrides } from './hygiene-thresholds.js';
export { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';

export type {
  HygieneIssueKind,
  HygieneCycleEdge,
  HygieneOverlapPeer,
  HygieneCleanupTarget,
  HeartbeatLoopCandidate,
  HygieneHeartbeatLoopTarget,
  HygieneIssue,
  HarnessWorktreeLag,
  DependencyCycle,
} from './hygiene/types.js';
export { STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND } from './hygiene/types.js';

export { pendingDecisionKey, formatLocalDateKey } from './hygiene/shared.js';
export { hasCloseReasonEvidence, needsCloseEvidenceLookup } from './hygiene/evidence.js';
export { hasLiveWorktreeEvidence } from './hygiene/lease.js';
export { findDependencyCycles } from './hygiene/cycles.js';
export { checkHygiene } from './hygiene/aggregate.js';
