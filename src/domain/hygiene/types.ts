import type { TicketId } from '../ticket-id.js';

// missing_priority は削除済み: bd が priority を 0..4 に強制し、
// bd-issue-schema.ts も同じ範囲に制限するため『priority 未設定』は表現不可能 (bdboard-2czx)。
export type HygieneIssueKind =
  | 'dependency_cycle'
  | 'overdue_defer'
  | 'stale_epic'
  | 'stale_in_progress'
  | 'unblocked_high_priority_idle'
  | 'stale_pending_decision'
  | 'merged_leftover'
  | 'orphan_heartbeat_loop'
  | 'in_flight_file_overlap'
  | 'closed_without_evidence'
  | 'reclaimed_live_worktree'
  | 'stale_harness_worktree';

export interface HygieneCycleEdge {
  readonly issueId: TicketId;
  readonly dependsOnId: TicketId;
}

/** in_flight_file_overlap の相手側。UI が「衝突しうる着手中チケット」を組み立てる材料 */
export interface HygieneOverlapPeer {
  readonly otherTicketId: TicketId;
  readonly files: readonly string[];
}

export interface HygieneCleanupTarget {
  readonly repoRootPath: string;
  readonly worktreePath: string | null;
  readonly branchName: string | null;
}

/** orphan_heartbeat_loop の入力。infra/app 層が組み立てて渡す */
export interface HeartbeatLoopCandidate {
  readonly pid: number;
  readonly commandLine: string;
  readonly sessionPid?: number;
  readonly sessionAlive?: boolean;
  readonly startedAt?: string;
}

/** orphan_heartbeat_loop のときだけ入る。UI が kill コマンドを組み立てる材料 */
export interface HygieneHeartbeatLoopTarget {
  readonly pid: number;
  /** 台帳で実在が確認できたチケットIDのみ。昇順 */
  readonly ticketIds: readonly TicketId[];
  readonly sessionPid?: number;
  /** ps の lstart 生文字列。kill コマンドの pid-reuse ガードに使う */
  readonly startedAt?: string;
  /** どちらの条件で警告したか。両方成立したら 'all_closed' を優先 */
  readonly reason: 'all_closed' | 'session_gone';
}

export interface HygieneIssue {
  readonly kind: HygieneIssueKind;
  readonly ticketId: TicketId;
  readonly projectId: string;
  readonly message: string;
  readonly severity: 'warning' | 'info';
  /**
   * merged_leftover のときだけ入る。UI が掃除コマンド文字列を組み立てる材料。
   *
   * 鏡像の `reclaimed_live_worktree` には**意図的に付けない** — 理由は
   * `checkReclaimedLiveWorktree` の末尾コメント。足す前にそこを読むこと。
   */
  readonly cleanup?: HygieneCleanupTarget;
  /** orphan_heartbeat_loop のときだけ入る。UI が kill コマンドを組み立てる材料 */
  readonly heartbeatLoop?: HygieneHeartbeatLoopTarget;
  /** overdue_defer のときだけ入る。Undo で元の日付へ戻すための材料 */
  readonly deferUntil?: string;
  /** dependency_cycle のときだけ入る */
  readonly cycleTicketIds?: readonly TicketId[];
  /** dependency_cycle のときだけ入る */
  readonly cycleEdges?: readonly HygieneCycleEdge[];
  /**
   * in_flight_file_overlap のときだけ入る。相手が複数でも 1 行に畳むので **配列**。
   * 相手 ID 昇順で、必ず 1 件以上。
   */
  readonly overlaps?: readonly HygieneOverlapPeer[];
}

/**
 * worktree が既定ブランチからどれだけ遅れているか (bdboard-tdua)。git を叩く必要が
 * あるのでドメインでは組み立てず、呼び出し側から受け取る。
 */
/**
 * 1 worktree ぶんの計測結果。**この一覧に載っていない worktree は「遅れていない」ではなく
 * 「測っていない / 測れなかった」**。scanHarnessWorktreeLags のコメントを参照。
 */
export interface HarnessWorktreeLag {
  readonly projectId: string;
  readonly ticketId: TicketId;
  readonly worktreePath: string;
  /** `git rev-list --count HEAD..<既定ブランチ>` の値 */
  readonly commitsBehind: number;
  /** 遅れの計測に実際に使えた既定ブランチ ref。 */
  readonly baseRef: string;
}

/**
 * ハーネスがこの数だけ遅れていたら「凍っている」とみなす。
 *
 * **数えているのは総コミット数ではなく、`.claude` と `harness` を触ったコミットだけ**
 * (countHarnessCommitsBehindDefaultBranch)。総数で測ると意味がリポジトリの速度に
 * 振り回される — この repo は実測 (2026-09-05) で 1 日 92 / 7 日 239 / 30 日 372 動くので、
 * 同じ閾値が日によって半日にも 4 日にも化ける。
 *
 * 3 の根拠: 同じ日の実測で、ハーネス差分は「生存プロセスを抱えた長命 worktree」が
 * 17 / 4、「その日のうちに作られた worktree」が 1 / 1 だった。3 はこの 2 つの帯の間に
 * ある。1 にすると、作った直後にハーネス PR が 1 本入っただけの正常な worktree まで
 * 鳴り、盤面が無視されるようになる。
 *
 * ここは意図的に **hygiene-thresholds の設定項目にしていない** — あちらは時間 (ms) と
 * 優先度の閾値だけを扱っており、UI もそれ前提。コミット数という別次元の単位を
 * 混ぜるより、事故が再発したときにこの定数を動かすほうが安い。
 */
export const STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND = 3;

export interface DependencyCycle {
  readonly ticketIds: readonly TicketId[];
  readonly edges: readonly HygieneCycleEdge[];
}
