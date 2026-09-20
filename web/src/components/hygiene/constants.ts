// bdboard-sso1.11: HygienePanel.tsx から純粋な定数を移動しただけのファイル。
// 挙動は一切変えていない。
import type { HygieneIssueKindDto } from '../../api';

export const COPY_FEEDBACK_MS = 2000;
export const REPAIR_FEEDBACK_MS = 4000;
export const HARNESS_DRIFT_KIND_LABEL = 'ハーネス要更新';
export const HARNESS_CONTRACT_KIND_LABEL = '検証コントラクト';
export const HARNESS_HOOKS_KIND_LABEL = 'hook 未登録';
export const STALE_LEASE_KIND_LABEL = 'stale lease（heartbeat 途絶）';
export const MERGE_SLOT_KIND_LABEL = 'マージスロット';
export const NON_TICKET_HARNESS_WORKTREE_KIND_LABEL = 'ハーネス凍結（非チケット）';
/**
 * stale lease が 0 件でも reclaim の見送り/エラーがあるときに単独で出す欄の種別ラベル。
 * stale lease 行の補足として出るときと違い、見出しが無いと何の欄か読めない (bdboard-0xsw)。
 */
export const RECLAIM_STATUS_KIND_LABEL = '自動 reclaim';

export const KIND_LABELS: Record<HygieneIssueKindDto, string> = {
  dependency_cycle: '循環依存',
  overdue_defer: '期限超過の保留',
  stale_epic: '完了済みエピック',
  stale_in_progress: '長期 in_progress',
  unblocked_high_priority_idle: '着手待ち高優先',
  stale_pending_decision: '放置された確認待ち',
  merged_leftover: '残骸 worktree',
  reclaimed_live_worktree: '誤回収の疑い',
  stale_harness_worktree: 'ハーネス凍結',
  orphan_heartbeat_loop: '残骸 heartbeat ループ',
  in_flight_file_overlap: '着手中の重複',
  closed_without_evidence: 'close 証拠なし',
};
