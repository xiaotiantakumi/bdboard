import { compareStrings } from './compare.js';
import { isBlockingKind } from './dependency.js';
import { computeStronglyConnectedComponents } from './graph-scc.js';
import {
  buildDirectChildrenIndex,
  epicProgressFromIndex,
} from './epic-progress.js';
import {
  createReadinessContext,
  isReady,
  type ReadinessContext,
} from './readiness.js';
import type { LeftoverCandidate } from './git-worktree.js';
import { parseHeartbeatLoopCommand } from './heartbeat-loop.js';
import {
  collectOverlapPeersByTicket,
  formatOverlapPeers,
  type InFlightOverlap,
  type InFlightOverlapPeer,
} from './in-flight-overlap.js';
import { isOpenLike } from './status.js';
import {
  resolveHygieneThresholds,
  type HygieneThresholds,
  type HygieneThresholdsOverrides,
} from './hygiene-thresholds.js';

export type { HygieneThresholds, HygieneThresholdsOverrides } from './hygiene-thresholds.js';
export { DEFAULT_HYGIENE_THRESHOLDS } from './hygiene-thresholds.js';
import type { Ticket } from './ticket.js';
import type { TicketId } from './ticket-id.js';

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
 * 確認待ち集合のキー。
 *
 * ticket.id だけで持つと、同じIDのチケットを持つ別プロジェクトが同時にスコープへ
 * 入っているときに取り違える。bd のIDはプロジェクト内でしか一意ではなく、盤面側は
 * humanLabeledIdsFromCache を **プロジェクト単位** で作っている
 * (src/application/board/get-board.ts) ので、健全性だけ全プロジェクト混ぜた集合で
 * 判定すると、盤面では通常レーンのチケットに「確認待ちが放置されている」が付く。
 * 依存循環の辺キー(collectCycleEdges)と同じ \0 結合で projectId を前置する。
 */
export function pendingDecisionKey(
  projectId: string,
  ticketId: TicketId,
): string {
  return `${projectId}\0${ticketId}`;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function inProgressAnchor(ticket: Ticket): Date | null {
  if (isValidDate(ticket.startedAt)) {
    return ticket.startedAt;
  }
  if (isValidDate(ticket.updatedAt)) {
    return ticket.updatedAt;
  }
  return null;
}

function hasBlockingDependencies(ticket: Ticket): boolean {
  return ticket.dependencies.some(
    (edge) => isBlockingKind(edge.kind) && edge.issueId === ticket.id,
  );
}

/**
 * Date を YYYY-MM-DD に整形する。
 *
 * timeZone 未指定時は実行環境のローカルタイムゾーン(getFullYear/getMonth/getDate)。
 * 指定時はその IANA タイムゾーンの暦日(UTC で slice すると JST では 1 日ずれる)。
 */
export function formatLocalDateKey(date: Date, timeZone?: string): string {
  if (timeZone !== undefined) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function checkOverdueDefer(
  ticket: Ticket,
  now: Date,
  timeZone?: string,
): HygieneIssue | null {
  if (ticket.status !== 'deferred') {
    return null;
  }
  if (!isValidDate(ticket.deferUntil)) {
    return null;
  }
  if (ticket.deferUntil.getTime() > now.getTime()) {
    return null;
  }

  // `bd defer --until=2026-08-10` は JST 深夜として `2026-08-09T15:00:00Z` に保存されるため、
  // `toISOString().slice(0,10)` のように UTC で切ると 1 日ずれる。Undo で元の日付へ戻すときに
  // ずれると別の日付に defer し直してしまうので、ローカルタイムゾーンで整形する。
  return {
    kind: 'overdue_defer',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: 'defer_until を過ぎていますが、まだ deferred のままです',
    severity: 'warning',
    deferUntil: formatLocalDateKey(ticket.deferUntil, timeZone),
  };
}

function checkStaleEpic(
  ticket: Ticket,
  childrenIndex: ReadonlyMap<TicketId, readonly TicketId[]>,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (ticket.status === 'closed') {
    return null;
  }

  const progress = epicProgressFromIndex(ticket.id, childrenIndex, ticketById);
  if (progress === null || progress.total === 0 || progress.done !== progress.total) {
    return null;
  }

  return {
    kind: 'stale_epic',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: '子チケットはすべて完了していますが、エピックが open のままです',
    severity: 'warning',
  };
}

function checkStaleInProgress(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  isPendingDecision: boolean,
): HygieneIssue | null {
  if (ticket.status !== 'in_progress' && ticket.status !== 'hooked') {
    return null;
  }
  // 確認待ちは stale_pending_decision の担当。deriveLane が human ラベルを
  // in_progress より優先する(src/domain/readiness.ts)ので、盤面が確認待ちに
  // 置いているカードに対して「長期 in_progress」と言うと、盤面に無いレーンの話に
  // なるうえ、同じ放置を2行で叱ることになる。
  if (isPendingDecision) {
    return null;
  }

  const anchor = inProgressAnchor(ticket);
  if (anchor === null) {
    return null;
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < thresholds.staleInProgressAfterMs) {
    return null;
  }

  const days = Math.floor(elapsedMs / (24 * 60 * 60_000));
  return {
    kind: 'stale_in_progress',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: `in_progress のまま ${days} 日以上経過しています`,
    severity: 'warning',
  };
}

function checkUnblockedHighPriorityIdle(
  ticket: Ticket,
  ctx: ReadinessContext,
  now: Date,
  thresholds: HygieneThresholds,
): HygieneIssue | null {
  if (!isOpenLike(ticket.status)) {
    return null;
  }
  if (ticket.priority > thresholds.highPriorityMax) {
    return null;
  }
  if (!hasBlockingDependencies(ticket)) {
    return null;
  }
  if (!isReady(ticket, ctx, now)) {
    return null;
  }

  return {
    kind: 'unblocked_high_priority_idle',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: 'ブロックは解除済みですが、高優先チケットが未着手のままです',
    severity: 'warning',
  };
}

/**
 * 確認待ち(awaiting_human)のまま放置されているチケットを拾う。
 *
 * awaiting_human は ticket.status ではなく bd の human ラベル由来の派生レーンで
 * (src/domain/readiness.ts の deriveLane)、Ticket 単体からは判定できない。呼び出し側が
 * 集めた pendingDecisionKeys を渡してもらう前提で、渡されなければ何も出さない。
 *
 * closed は除外する。deriveLane も closed を done で上書きしていて(human ラベルの
 * 外し忘れでチケットが再浮上しないための保険)、盤面で done のカードが健全性だけ
 * 「確認待ちが放置されている」と言い出すのは矛盾になる。
 */
function checkStalePendingDecision(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  isPendingDecision: boolean,
  lastCommentAt: Date | undefined,
): HygieneIssue | null {
  if (!isPendingDecision) {
    return null;
  }
  if (ticket.status === 'closed') {
    return null;
  }
  if (!isValidDate(ticket.updatedAt)) {
    return null;
  }

  // 遅いほうを取る。コメントのほうが古いこと自体は普通にある(コメント後に
  // 優先度を変えた等)ので、どちらか一方に決め打ちはしない。
  const anchor =
    isValidDate(lastCommentAt) && lastCommentAt.getTime() > ticket.updatedAt.getTime()
      ? lastCommentAt
      : ticket.updatedAt;

  const elapsedMs = now.getTime() - anchor.getTime();
  if (elapsedMs < thresholds.stalePendingDecisionAfterMs) {
    return null;
  }

  const days = Math.floor(elapsedMs / (24 * 60 * 60_000));
  return {
    kind: 'stale_pending_decision',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message: `確認待ちのまま ${days} 日以上動きがありません`,
    severity: 'warning',
  };
}

const MERGE_SLOT_LABEL = 'gt:slot';

function isExcludedFromClosedWithoutEvidence(ticket: Ticket): boolean {
  if (ticket.issueType === 'epic' || ticket.issueType === 'gate') {
    return true;
  }
  return ticket.labels?.includes(MERGE_SLOT_LABEL) ?? false;
}

const PR_WORD_PATTERN = /(?:^|[^a-zA-Z0-9])PR(?:[^a-zA-Z0-9]|$)/i;

function hasPrWordMention(text: string): boolean {
  return PR_WORD_PATTERN.test(text);
}

export function hasCloseReasonEvidence(closeReason: string): boolean {
  if (hasPrWordMention(closeReason)) {
    return true;
  }
  if (/#\d+/.test(closeReason)) {
    return true;
  }
  if (/merge/i.test(closeReason)) {
    return true;
  }
  if (closeReason.includes('マージ')) {
    return true;
  }
  return false;
}

/**
 * closed_without_evidence の判定でコメント本文を引く必要があるチケットか。
 *
 * アプリ層 (get-close-evidence.ts) がフェッチ対象を絞るために使う。ここに集約
 * しないと、除外条件がドメインとアプリ層で二重管理になり、片方だけ直したときに
 * 「UI には出ないのに bd だけ叩かれる」ような無駄が静かに発生する。
 */
export function needsCloseEvidenceLookup(
  ticket: Ticket,
  now: Date,
  windowMs: number,
): boolean {
  if (ticket.status !== 'closed') {
    return false;
  }
  if (!isValidDate(ticket.closedAt)) {
    return false;
  }
  const elapsedMs = now.getTime() - ticket.closedAt.getTime();
  if (elapsedMs < 0 || elapsedMs > windowMs) {
    return false;
  }
  if (ticket.commentCount <= 0) {
    return false;
  }
  if (isExcludedFromClosedWithoutEvidence(ticket)) {
    return false;
  }
  if (ticket.closeReason !== undefined && hasCloseReasonEvidence(ticket.closeReason)) {
    return false;
  }
  return true;
}

function hasCloseEvidence(
  ticket: Ticket,
  closeEvidenceKeys: ReadonlySet<string> | undefined,
): boolean {
  const key = pendingDecisionKey(ticket.projectId, ticket.id);
  if (closeEvidenceKeys?.has(key) ?? false) {
    return true;
  }
  if (ticket.closeReason !== undefined && hasCloseReasonEvidence(ticket.closeReason)) {
    return true;
  }
  return false;
}

/**
 * close 済みだが PR/検証の記録がないチケットを拾う。
 *
 * closeReason は bd の close 理由文。コメント由来の証拠は closeEvidenceKeys で
 * 渡す (pendingCommentAnchors と同じ流儀)。未指定なら closeReason のみで判定する。
 */
function checkClosedWithoutEvidence(
  ticket: Ticket,
  now: Date,
  thresholds: HygieneThresholds,
  closeEvidenceKeys: ReadonlySet<string> | undefined,
  closeEvidenceUnknownKeys: ReadonlySet<string> | undefined,
  closeEvidenceAvailable: boolean,
): HygieneIssue | null {
  if (!closeEvidenceAvailable) {
    return null;
  }
  if (ticket.status !== 'closed') {
    return null;
  }
  if (isExcludedFromClosedWithoutEvidence(ticket)) {
    return null;
  }
  if (!isValidDate(ticket.closedAt)) {
    return null;
  }

  const elapsedMs = now.getTime() - ticket.closedAt.getTime();
  if (elapsedMs < 0 || elapsedMs > thresholds.closedWithoutEvidenceWindowMs) {
    return null;
  }

  const key = pendingDecisionKey(ticket.projectId, ticket.id);
  if (closeEvidenceUnknownKeys?.has(key) ?? false) {
    return null;
  }

  if (hasCloseEvidence(ticket, closeEvidenceKeys)) {
    return null;
  }

  return {
    kind: 'closed_without_evidence',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message:
      'close 済みだが PR/検証の記録がない（close-template.md の書式でコメントを残す）',
    severity: 'info',
  };
}

function checkMergedLeftover(
  candidate: LeftoverCandidate,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (candidate.worktreePath === null && candidate.branchName === null) {
    return null;
  }

  const ticket = ticketById.get(candidate.ticketId);
  if (ticket === undefined) {
    return null;
  }
  if (ticket.status !== 'closed') {
    return null;
  }
  if (ticket.projectId !== candidate.projectId) {
    return null;
  }

  let message: string;
  if (candidate.worktreePath !== null && candidate.branchName !== null) {
    message = 'チケットは closed ですが worktree とブランチが残っています';
  } else if (candidate.worktreePath !== null) {
    message = 'チケットは closed ですが worktree が残っています';
  } else {
    message = 'チケットは closed ですがブランチが残っています';
  }

  return {
    kind: 'merged_leftover',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message,
    severity: 'warning',
    cleanup: {
      repoRootPath: candidate.repoRootPath,
      worktreePath: candidate.worktreePath,
      branchName: candidate.branchName,
    },
  };
}

/**
 * merged_leftover の鏡像 (bdboard-rkde)。
 *
 * merged_leftover は「チケットは closed なのに worktree/ブランチが残っている」を見る。
 * こちらは **「チケットは open (＝ bd ready が空きとして提示する) なのに worktree か
 * ブランチが存在する」** を見る。
 *
 * この盤面は 2026-09-05 に 4 件同時に発生した。常時稼働サーバーの reclaim スケジューラが
 * lease だけを見て回収するため、heartbeat を打っていない生存セッションのチケットが
 * 作業中に open へ戻される。当人はそのまま PR を出すので、台帳だけが「空き」と言い続ける。
 * 回収そのものは `bd history <id> --events` に `lease_reclaimed` として残る (実測 2026-09-05:
 * `05:52:41 lease_reclaimed by ...`。bd history は UTC 表記)。ただし `bd show` には出ないので、台帳を1件ずつ開かない
 * 限り気付けない。この述語は**盤面から候補を一覧にする**ためのもので、手動の
 * `bd update -s open` との確定的な切り分けは上の history コマンドが担う。
 *
 * worktree/ブランチの存在を生存の代理指標に使えるのは、ワークフロー上それらが
 * claim からマージ後の掃除までの間しか存在しないため (docs/GIT-WORKFLOW.md)。
 * 掃除漏れとの区別は付かないが、掃除漏れもまた対処すべき盤面なので実害はない。
 *
 * in_progress は対象外。そちらは lease が生きている正常な状態か、さもなくば
 * stale_in_progress が拾う。
 */
function checkReclaimedLiveWorktree(
  candidate: LeftoverCandidate,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (candidate.worktreePath === null && candidate.branchName === null) {
    return null;
  }

  const ticket = ticketById.get(candidate.ticketId);
  if (ticket === undefined) {
    return null;
  }
  if (ticket.status !== 'open') {
    return null;
  }
  if (ticket.projectId !== candidate.projectId) {
    return null;
  }

  // 助詞の付き方は merged_leftover (上) と揃える。分岐ごとに文全体を組むのは
  // `${evidence} が` にすると「ブランチ が」と不自然に割れるため。
  let evidence: string;
  if (candidate.worktreePath !== null && candidate.branchName !== null) {
    evidence = 'チケットは open ですが worktree とブランチが残っています';
  } else if (candidate.worktreePath !== null) {
    evidence = 'チケットは open ですが worktree が残っています';
  } else {
    evidence = 'チケットは open ですがブランチが残っています';
  }

  return {
    kind: 'reclaimed_live_worktree',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message:
      `${evidence}。作業中に自動 reclaim された可能性があります。` +
      `bd ready が空きとして提示するので、作業が生きているなら bd update ${ticket.id} --claim で claim し直してください` +
      `（確認: bd history ${ticket.id} --events の直近の状態変更が lease_reclaimed なら自動回収です）`,
    severity: 'warning',
    // **cleanup は意図的に付けない (bdboard-rkde)。** merged_leftover と同じ候補を使うが、
    // 提案すべき対処は正反対である。UI の cleanup は lsof ガード付きとはいえ
    // `git worktree remove` + `branch -d` を出す (web/src/bdCommands.ts)。この kind が
    // 見ているのは「まだ生きているかもしれない作業」なので、そこに削除コマンドを
    // 添えるのは最悪の誤誘導になる。対処は claim し直すことで、message に書いてある。
  };
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

/**
 * 「稼働中のセッションが、main から大きく遅れた worktree に居る」を拾う (bdboard-tdua)。
 *
 * 注入コピー (`.claude/skills/` と `.claude/settings.json`) は**チェックアウト単位**で、
 * worktree は作成時点の main で凍る。長命の worktree に居るセッションは、hooks も
 * スクリプトも規律本文も古いまま動き続ける。本人からは「ハーネスが入っている」ように
 * しか見えないので、**外から測らないと気付けない**。
 *
 * 実測 (2026-09-05): ハーネス差分 17 コミットの worktree で稼働していたセッションが、
 * 同じ日にハーネス改善 PR をマージしていた。自分がマージした改善が自分には効いていない。
 *
 * in_progress のチケットだけを見る。誰も作業していない worktree が古いのは当たり前で、
 * それは merged_leftover / reclaimed_live_worktree の担当。
 *
 * **見えている範囲は `bd/<id>` worktree に限る。** Claude Code の `isolation: "worktree"`
 * が作る `feature/<slug>` のような非チケット worktree は、紐づくチケットが無いため
 * Hygiene issue の形に載らない (HygieneIssue.ticketId は必須)。実測ではそちらのほうが
 * 深く凍っていたので、対応は bdboard-wadg。
 */
function checkStaleHarnessWorktree(
  lag: HarnessWorktreeLag,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  if (lag.commitsBehind < STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND) {
    return null;
  }

  const ticket = ticketById.get(lag.ticketId);
  if (ticket === undefined) {
    return null;
  }
  if (ticket.status !== 'in_progress') {
    return null;
  }
  if (ticket.projectId !== lag.projectId) {
    return null;
  }

  return {
    kind: 'stale_harness_worktree',
    ticketId: ticket.id,
    projectId: ticket.projectId,
    message:
      `この worktree のハーネスは origin/main より ${lag.commitsBehind} コミットぶん古いままです。` +
      'ハーネス (.claude/skills と .claude/settings.json) はチェックアウト単位なので、' +
      'このセッションは worktree 作成時点の古い規律・hooks のまま動いています。' +
      `git -C ${lag.worktreePath} rebase origin/main で追従してください`,
    severity: 'warning',
    // cleanup は付けない。rebase は掃除ではないうえ、未コミットの成果を抱えた
    // worktree に対してワンクリック相当のコマンドを出すのは危険。
  };
}

function checkOrphanHeartbeatLoop(
  candidate: HeartbeatLoopCandidate,
  ticketById: ReadonlyMap<TicketId, Ticket>,
): HygieneIssue | null {
  const parsed = parseHeartbeatLoopCommand(candidate.commandLine);
  const knownTickets = parsed.ticketIdCandidates
    .map((ticketId) => ticketById.get(ticketId))
    .filter((ticket): ticket is Ticket => ticket !== undefined);

  if (knownTickets.length === 0) {
    return null;
  }

  if (parsed.ticketIdCandidates.length !== knownTickets.length) {
    return null;
  }

  const sortedKnownTickets = [...knownTickets].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const ticketIds = sortedKnownTickets.map((ticket) => ticket.id);
  const representative = sortedKnownTickets[0]!;

  const allClosed = sortedKnownTickets.every((ticket) => ticket.status === 'closed');
  // sessionAlive が undefined（pidfile も --session-pid もない手書きループ）は、
  // 意図的に「セッション消失」を理由には警告しません（全チケット closed なら別理由で警告します）。
  // undefined は「セッションが死んでいる」ではなく、「生死が分からない」という意味です。
  // bdboard-7j49 で ps -o ppid= の ppid === 1 を代理指標にできるか実測し、却下しました。
  // nohup ... & でデタッチしたループは健全でも起動直後に ppid 1 になり、
  // 同梱の bd-heartbeat.sh 自身もこの形で起動するため、偽陽性と区別できません。
  // 実際に、起動から約1秒で ppid 1 になる健全なループを確認しています。
  // 親が tmux 等の長命プロセスなら、セッションが死んでも ppid は 1 にならず偽陰性です。
  // macOS では全プロセスの 718/892（約8割）が ppid 1 で、そもそも情報量がありません。
  // pgid リーダーの死亡や tty 無しも、健全なデタッチ済みループで成立するため使えません。
  // 再提案するなら代理指標ではなく、pidfile / --session-pid のような明示的なセッション識別子を増やします。
  const sessionGone = candidate.sessionAlive === false;

  if (!allClosed && !sessionGone) {
    return null;
  }

  const reason: HygieneHeartbeatLoopTarget['reason'] = allClosed
    ? 'all_closed'
    : 'session_gone';

  const ticketList = ticketIds.join(', ');
  const message =
    reason === 'all_closed'
      ? `対象チケットがすべて closed なのに heartbeat ループ (pid ${candidate.pid}) が残っています: ${ticketList}`
      : `起動元セッション (pid ${candidate.sessionPid}) は終了していますが heartbeat ループ (pid ${candidate.pid}) が残っています: ${ticketList}`;

  return {
    kind: 'orphan_heartbeat_loop',
    ticketId: representative.id,
    projectId: representative.projectId,
    message,
    severity: 'warning',
    heartbeatLoop: {
      pid: candidate.pid,
      ticketIds,
      reason,
      ...(candidate.sessionPid !== undefined ? { sessionPid: candidate.sessionPid } : {}),
      ...(candidate.startedAt !== undefined ? { startedAt: candidate.startedAt } : {}),
    },
  };
}

/**
 * 着手中チケット同士のファイル重複を、**1 チケット 1 行** に畳んで出す。
 *
 * 相手が複数いてもチケットあたり 1 行にする。ペアごとに 1 行だと、3 件と重なって
 * いるチケットが 3 行に散って読みにくいうえ、UI 側の行キー (kind + ticketId) が
 * 一意でなくなる。相手は message と `overlaps` に並べる。
 *
 * 一方で **対称性は保つ**: 片側だけに出すと相手のチケットを開いている人には何も
 * 見えないので、ペアの両側それぞれに 1 行ずつ出す。
 *
 * severity は info。重複していること自体はまだ失敗ではなく「今のうちに片方へ寄せるか
 * 順番を決めろ」という合図で、warning にすると本当に直すべき行に埋もれる。
 */
function checkInFlightOverlaps(
  overlaps: readonly InFlightOverlap[],
  ticketById: ReadonlyMap<TicketId, Ticket>,
): readonly HygieneIssue[] {
  const issues: HygieneIssue[] = [];

  for (const group of collectOverlapPeersByTicket(overlaps)) {
    const ticket = ticketById.get(group.ticketId);
    if (ticket === undefined) {
      continue;
    }
    if (ticket.projectId !== group.projectId) {
      continue;
    }

    const peers: readonly HygieneOverlapPeer[] = group.peers.map(
      (peer: InFlightOverlapPeer) => ({
        otherTicketId: peer.ticketId,
        files: peer.files,
      }),
    );

    issues.push({
      kind: 'in_flight_file_overlap',
      ticketId: group.ticketId,
      projectId: group.projectId,
      message: `着手中の ${peers.length} 件と同じファイルを編集中: ${formatOverlapPeers(group.peers)}`,
      severity: 'info',
      overlaps: peers,
    });
  }

  return issues;
}

export interface DependencyCycle {
  readonly ticketIds: readonly TicketId[];
  readonly edges: readonly HygieneCycleEdge[];
}

function buildBlocksIndex(
  tickets: readonly Ticket[],
  ticketById: ReadonlyMap<TicketId, Ticket>,
): Map<TicketId, TicketId[]> {
  const index = new Map<TicketId, TicketId[]>();

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
        continue;
      }
      if (!ticketById.has(edge.issueId) || !ticketById.has(edge.dependsOnId)) {
        continue;
      }

      let successors = index.get(edge.dependsOnId);
      if (successors === undefined) {
        successors = [];
        index.set(edge.dependsOnId, successors);
      }
      successors.push(edge.issueId);
    }
  }

  return index;
}

function compareCycleEdges(
  a: HygieneCycleEdge,
  b: HygieneCycleEdge,
): number {
  const issueDiff = compareStrings(a.issueId, b.issueId);
  if (issueDiff !== 0) {
    return issueDiff;
  }
  return compareStrings(a.dependsOnId, b.dependsOnId);
}

function collectCycleEdges(
  tickets: readonly Ticket[],
  memberSet: ReadonlySet<TicketId>,
): readonly HygieneCycleEdge[] {
  const seen = new Set<string>();
  const edges: HygieneCycleEdge[] = [];

  for (const ticket of tickets) {
    for (const edge of ticket.dependencies) {
      if (edge.kind !== 'blocks') {
        continue;
      }
      if (!memberSet.has(edge.issueId) || !memberSet.has(edge.dependsOnId)) {
        continue;
      }

      const key = `${edge.issueId}\0${edge.dependsOnId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ issueId: edge.issueId, dependsOnId: edge.dependsOnId });
    }
  }

  return edges.sort(compareCycleEdges);
}

export function findDependencyCycles(
  tickets: readonly Ticket[],
): readonly DependencyCycle[] {
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const blocksIndex = buildBlocksIndex(tickets, ticketById);

  function neighbors(id: TicketId): readonly TicketId[] {
    return (blocksIndex.get(id) ?? []).filter((successor) => ticketById.has(successor));
  }

  const { sccMembers } = computeStronglyConnectedComponents(
    tickets.map((ticket) => ticket.id),
    neighbors,
  );

  const cycles: DependencyCycle[] = [];

  for (const component of sccMembers) {
    if (component.length < 2) {
      continue;
    }

    const ticketIds = [...component].sort(compareStrings);
    const memberSet = new Set(ticketIds);
    const edges = collectCycleEdges(tickets, memberSet);
    cycles.push({ ticketIds, edges });
  }

  return cycles.sort((a, b) => compareStrings(a.ticketIds[0]!, b.ticketIds[0]!));
}

/**
 * 表示順。**Record にしてあるのは網羅性を tsc に強制させるため** — 配列だと新しい kind を
 * 足し忘れても `indexOf` が -1 を返して黙って先頭に並ぶ (bdboard-rkde のレビュー指摘)。
 */
const KIND_ORDER: Record<HygieneIssueKind, number> = {
  dependency_cycle: 0,
  overdue_defer: 1,
  stale_epic: 2,
  stale_in_progress: 3,
  unblocked_high_priority_idle: 4,
  stale_pending_decision: 5,
  closed_without_evidence: 6,
  merged_leftover: 7,
  reclaimed_live_worktree: 8,
  stale_harness_worktree: 9,
  orphan_heartbeat_loop: 10,
  in_flight_file_overlap: 11,
};

function compareIssues(a: HygieneIssue, b: HygieneIssue): number {
  const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (kindDiff !== 0) {
    return kindDiff;
  }
  const projectDiff = compareStrings(a.projectId, b.projectId);
  if (projectDiff !== 0) {
    return projectDiff;
  }
  return compareStrings(a.ticketId, b.ticketId);
}

export function checkHygiene(
  tickets: readonly Ticket[],
  ctx: {
    readonly now: Date;
    readonly thresholds?: HygieneThresholdsOverrides;
    readonly leftoverCandidates?: readonly LeftoverCandidate[];
    /**
     * 走査した bd heartbeat ループ。ps を叩く必要があるのでドメインでは組み立てず、
     * 呼び出し側から受け取る。未指定なら orphan_heartbeat_loop は一切出ない。
     */
    readonly heartbeatLoops?: readonly HeartbeatLoopCandidate[];
    /**
     * 着手中 worktree 同士のファイル重複 (scanInFlightOverlaps の戻り)。git を叩く
     * 必要があるのでドメインでは組み立てず、呼び出し側から受け取る。未指定なら
     * in_flight_file_overlap は一切出ない。
     */
    readonly inFlightOverlaps?: readonly InFlightOverlap[];
    /**
     * 着手中 worktree が既定ブランチから何コミット遅れているか (scanHarnessWorktreeLags
     * の戻り)。git を叩く必要があるのでドメインでは組み立てず、呼び出し側から受け取る。
     * 未指定なら stale_harness_worktree は一切出ない。
     */
    readonly harnessWorktreeLags?: readonly HarnessWorktreeLag[];
    /**
     * 確認待ち(awaiting_human)のチケット。bd の human ラベル由来で Ticket からは
     * 判定できないため、呼び出し側が集めて渡す。キーは pendingDecisionKey() で
     * projectId を前置したもの。未指定なら stale_pending_decision は一切出ない。
     */
    readonly pendingDecisionKeys?: ReadonlySet<string>;
    /**
     * 確認待ちチケットの最終コメント日時。キーは pendingDecisionKeys と同じ
     * pendingDecisionKey()。stale_pending_decision のアンカーを
     * max(updatedAt, ここの値) にするためだけに使う。未指定なら updatedAt のみ。
     */
    readonly pendingCommentAnchors?: ReadonlyMap<string, Date>;
    /**
     * PR/検証の記録が **コメント本文** にあるチケットのキー集合
     * (`pendingDecisionKey(projectId, ticketId)` と同じ \0 結合キー)。
     *
     * コメント本文は bd を1件ずつ叩かないと取れず、全文をキャッシュに積むとメモリを
     * 食うので、アプリ層で「PR: / 検証: を含むコメントがあるか」という真偽値まで
     * 潰してから集合として渡す (pendingCommentAnchors と同じ設計)。未指定なら
     * コメントは見ず closeReason だけで判定する。
     */
    readonly closeEvidenceKeys?: ReadonlySet<string>;
    /**
     * コメント本文をまだ確認できていないチケットのキー集合
     * (`pendingDecisionKey` と同じ \0 結合キー)。
     *
     * bd comments は1件 0.8〜2.8s かかるので、アプリ層は1リクエストあたりの
     * フェッチ件数に上限を設ける。上限に達して未確認のまま残ったチケットは
     * 「証拠なし」ではなく **未確認** であり、ここに載る。
     *
     * 未確認は検出しない。証拠なしと同一視すると、キャッシュが冷えている間だけ
     * 100件規模の誤検知が並び、しばらくして勝手に消えることになる — hygiene は
     * 「まだ調べていない」を「問題あり」と言ってはいけない。
     */
    readonly closeEvidenceUnknownKeys?: ReadonlySet<string>;
    /**
     * コメント本文を読む手段があるか。false なら closed_without_evidence の判定自体を
     * 行わない。
     *
     * 一部が未確認のときは非検出にしているのに、コメントを1件も読めない環境で
     * だけ全件検出するのは逆立ちしている (未確認を「証拠なし」と断定することになる)。
     * 既定 true。
     */
    readonly closeEvidenceAvailable?: boolean;
    readonly timeZone?: string;
  },
): readonly HygieneIssue[] {
  const thresholds = resolveHygieneThresholds(ctx.thresholds);
  const closeEvidenceAvailable = ctx.closeEvidenceAvailable ?? true;
  const readiness = createReadinessContext(tickets);
  const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket] as const));
  const childrenIndex = buildDirectChildrenIndex(tickets);
  const issues: HygieneIssue[] = [];

  for (const ticket of tickets) {
    const overdueDefer = checkOverdueDefer(ticket, ctx.now, ctx.timeZone);
    if (overdueDefer !== null) {
      issues.push(overdueDefer);
    }

    const staleEpic = checkStaleEpic(ticket, childrenIndex, ticketById);
    if (staleEpic !== null) {
      issues.push(staleEpic);
    }

    const decisionKey = pendingDecisionKey(ticket.projectId, ticket.id);
    const isPendingDecision = ctx.pendingDecisionKeys?.has(decisionKey) ?? false;

    const staleInProgress = checkStaleInProgress(
      ticket,
      ctx.now,
      thresholds,
      isPendingDecision,
    );
    if (staleInProgress !== null) {
      issues.push(staleInProgress);
    }

    const stalePendingDecision = checkStalePendingDecision(
      ticket,
      ctx.now,
      thresholds,
      isPendingDecision,
      ctx.pendingCommentAnchors?.get(decisionKey),
    );
    if (stalePendingDecision !== null) {
      issues.push(stalePendingDecision);
    }

    const unblockedIdle = checkUnblockedHighPriorityIdle(
      ticket,
      readiness,
      ctx.now,
      thresholds,
    );
    if (unblockedIdle !== null) {
      issues.push(unblockedIdle);
    }

    const closedWithoutEvidence = checkClosedWithoutEvidence(
      ticket,
      ctx.now,
      thresholds,
      ctx.closeEvidenceKeys,
      ctx.closeEvidenceUnknownKeys,
      closeEvidenceAvailable,
    );
    if (closedWithoutEvidence !== null) {
      issues.push(closedWithoutEvidence);
    }
  }

  if (ctx.leftoverCandidates !== undefined) {
    for (const candidate of ctx.leftoverCandidates) {
      const mergedLeftover = checkMergedLeftover(candidate, ticketById);
      if (mergedLeftover !== null) {
        issues.push(mergedLeftover);
      }
      // 同じ候補列を鏡像の述語でもう一度見る。両者は status で排他 (closed / open) なので
      // 1つの候補が両方に載ることはない。
      const reclaimedLive = checkReclaimedLiveWorktree(candidate, ticketById);
      if (reclaimedLive !== null) {
        issues.push(reclaimedLive);
      }
    }
  }

  if (ctx.harnessWorktreeLags !== undefined) {
    for (const lag of ctx.harnessWorktreeLags) {
      const staleHarness = checkStaleHarnessWorktree(lag, ticketById);
      if (staleHarness !== null) {
        issues.push(staleHarness);
      }
    }
  }

  if (ctx.heartbeatLoops !== undefined) {
    for (const candidate of ctx.heartbeatLoops) {
      const orphanHeartbeatLoop = checkOrphanHeartbeatLoop(candidate, ticketById);
      if (orphanHeartbeatLoop !== null) {
        issues.push(orphanHeartbeatLoop);
      }
    }
  }

  if (ctx.inFlightOverlaps !== undefined) {
    issues.push(...checkInFlightOverlaps(ctx.inFlightOverlaps, ticketById));
  }

  for (const cycle of findDependencyCycles(tickets)) {
    const representativeId = cycle.ticketIds[0]!;
    const representative = ticketById.get(representativeId);
    if (representative === undefined) {
      continue;
    }

    issues.push({
      kind: 'dependency_cycle',
      ticketId: representativeId,
      projectId: representative.projectId,
      message: `${cycle.ticketIds.length}件のチケットが循環依存(blocks)しています: ${cycle.ticketIds.join(', ')}`,
      severity: 'warning',
      cycleTicketIds: cycle.ticketIds,
      cycleEdges: cycle.edges,
    });
  }

  return [...issues].sort(compareIssues);
}
