// src/domain/harness-kpi.ts は bdboard-sso1.52 でモジュール分割された。実体は
// ./harness-kpi/ 配下。このファイルは import 側 (application/board・application/lease・
// 既存の harness-kpi.test.ts 等) を書き換えないための re-export 入口としてのみ残す。
// 挙動・型は一切変えていない (移動のみ)。
//
// 分割前は isInRange (期間判定) が同じファイル内の非公開関数だった。分割後は
// サブモジュール間の cross-module import のために export を付けているものがあるが、
// ここで `export *` を使うと元は非公開だった補助関数まで公開エクスポート面に漏れて
// しまう。よって公開面は分割前の export 一覧のとおり名前を明示して re-export する
// (harness-contract.ts の分割 (PR #568) / board.ts の分割 (PR #595) と同じ方式。回帰ガードは
// harness-kpi.exportSurface.test.ts / harness-kpi-type-export-surface.check.ts)。
export {
  PENDING_DECISION_LABEL,
  PENDING_DECISION_ISSUE_TYPE,
  HARNESS_LABELS,
  DUPLICATE_MENTION_PATTERN,
  RECLAIM_RECLAIM_WINDOW_MS,
} from './harness-kpi/types.js';
export type {
  HarnessKpiRange,
  ReclaimRunRecord,
  PendingDecisionDwellKpi,
  ReclaimKpi,
  HarnessShareKpi,
  HarnessKpi,
  ComputeHarnessKpiInput,
} from './harness-kpi/types.js';

export {
  isPendingDecisionTicket,
  computePendingDecisionDwell,
} from './harness-kpi/pending-decision.js';

export { percentileMs } from './harness-kpi/percentile.js';

export { computeReclaimKpi } from './harness-kpi/reclaim.js';

export {
  hasHarnessLabel,
  mentionsDuplicate,
  computeHarnessLabeledShare,
  computeDuplicateMentionShare,
} from './harness-kpi/share.js';

export { computeHarnessKpi } from './harness-kpi/aggregate.js';
