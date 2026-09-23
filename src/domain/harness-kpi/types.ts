import type { LeftoverCandidate } from '../git-worktree.js';
import type { Ticket } from '../ticket.js';
import type { TicketId } from '../ticket-id.js';

/**
 * ハーネス自体の効き目を測る 5 指標 (docs/HARNESS-EVALUATION.md §4.4 / §5 P4)。
 *
 * すべて純粋関数で、入力は「板面キャッシュに載っている Ticket[]」と
 * 「reclaim 実行の記録 (ReclaimRunRecord[])」だけ。新しい永続化は要らない。
 */

/** 確認待ち(awaiting_human)の判定に使う bd ラベル。 */
export const PENDING_DECISION_LABEL = 'human';

/**
 * 確認待ちの判定に使う bd の issue type。
 *
 * gate は await_type (decision / review など) を問わず全部数える。`Ticket` は
 * await_type を保持していないので、そもそもドメイン層では種別を判別できない —
 * 分けたいなら先に Ticket 側へ await_type を写すところから。
 */
export const PENDING_DECISION_ISSUE_TYPE = 'gate';

/** ハーネス起票とみなすラベル。 */
export const HARNESS_LABELS: readonly string[] = ['harness', 'harness-upstream'];

/**
 * 重複/再発チケットの粗い代理指標。title + description に当てる。
 * 単語境界を持たない日本語を含むので誤検出はする — UI 側で「粗い指標」と注記する。
 */
export const DUPLICATE_MENTION_PATTERN = /重複|duplicate|再発|二重|統合/i;

/** 「reclaim 直後の再 claim」とみなす猶予 (30 分)。 */
export const RECLAIM_RECLAIM_WINDOW_MS = 30 * 60_000;

export interface HarnessKpiRange {
  readonly start: Date;
  readonly end: Date;
}

/**
 * reclaim の 1 実行分の記録。application 層のリングバッファが積む。
 *
 * `reclaimedCount` は parse-reclaim-output が stdout から読めた件数 (読めなければ
 * null)、`ticketIds` は同じく stdout から拾えたチケットID。bd の出力形式は保証が
 * 無いので、どちらも「取れたら取る」扱いにしている。
 */
export interface ReclaimRunRecord {
  readonly projectId: string;
  readonly at: Date;
  readonly reclaimedCount: number | null;
  readonly ticketIds: readonly TicketId[];
}

export interface PendingDecisionDwellKpi {
  /**
   * 期間内に**確認待ちのまま close された**チケット数 (中央値/p90 の母数)。
   *
   * bdboard-xgvh 以降、作業チケットへの回答は human ラベルを外すだけで close しない。
   * その結果、回答済みの作業チケットは板面から見て「確認待ちでも未クローズでもない」
   * 状態になり、この母数からも openCount からも消える。gate は回答＝close なので
   * 素直に入る。内訳が読めるよう gate / work を分けて数える。
   */
  readonly closedCount: number;
  /** そのうち issue_type=gate のもの */
  readonly closedGateCount: number;
  /** そのうち human ラベル付きの作業チケット (gate 以外) */
  readonly closedWorkCount: number;
  /** いま未クローズの確認待ちチケット数。**期間で絞らない現在値** */
  readonly openCount: number;
  /** そのうち issue_type=gate のもの */
  readonly openGateCount: number;
  /** そのうち human ラベル付きの作業チケット (gate 以外) */
  readonly openWorkCount: number;
  readonly medianMs: number | null;
  readonly p90Ms: number | null;
  /**
   * 滞留時間の起点。bd からラベル付与時刻が取れないので、いまは常に作成時刻
   * ('created')。UI はこの値を見て「作成時刻で代替」と注記する。
   */
  readonly anchor: 'created';
}

export interface ReclaimKpi {
  /** 期間内に記録された reclaim 発火回数 */
  readonly runCount: number;
  /** そのうち件数が読めた分の合計 */
  readonly reclaimedCountTotal: number;
  /** 件数が読めなかった発火回数 */
  readonly unknownCountRunCount: number;
  /** stdout から拾えて、かつ板面のチケットに紐付いた回収 ID の数 (率の母数) */
  readonly identifiedTicketCount: number;
  /** そのうち windowMs 以内に再び in_progress になった数 */
  readonly reclaimedThenInProgressCount: number;
  /** 誤回収の代理指標。母数 0 なら null */
  readonly reclaimedThenInProgressRate: number | null;
  readonly windowMs: number;
  /**
   * identifiedTicketCount のうち、**現時点で** ticket.status === 'open' かつ
   * worktree かブランチが残っている数 (bdboard-rkde の `reclaimed_live_worktree` /
   * `checkReclaimedLiveWorktree` と同じ生存判定 = open ゲート付きの
   * `hasLiveWorktreeEvidence`)。open ゲートが無いと、回収後に別セッションが
   * 再 claim して worktree を作り直した正常系まで誤回収として数えてしまう
   * (bdboard-t3ct M1)。
   *
   * 回収時点の状態そのものではなく「いま見えている生存証拠」を見るので、回収
   * 直後に掃除された誤回収は数え損なう一方 (下振れ)、`checkReclaimedLiveWorktree`
   * と同じく掃除がまだ終わっていないだけの盤面との区別も付かない (上振れうる)。
   * どちらにも振れるので「実測値の下限」とは言えない。母数のスキャン
   * (leftoverCandidates) 自体が git を読めず不完全だったときにこの値を
   * どう扱うかは呼び出し元の責務 — /api/harness-kpi ルートはスキャン不完全
   * (scanGitLeftovers().complete === false) なら DTO で null に上書きする
   * (bdboard-t3ct M2)。
   */
  readonly reclaimedLiveWorktreeCount: number;
  /** 母数 (identifiedTicketCount) が 0 なら null */
  readonly reclaimedLiveWorktreeRate: number | null;
}

export interface HarnessShareKpi {
  readonly matchedCount: number;
  readonly totalCount: number;
  /** 母数 0 なら null */
  readonly rate: number | null;
}

export interface HarnessKpi {
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly pendingDecisionDwell: PendingDecisionDwellKpi;
  readonly reclaim: ReclaimKpi;
  readonly harnessLabeled: HarnessShareKpi;
  readonly duplicateMention: HarnessShareKpi;
}

export interface ComputeHarnessKpiInput {
  readonly tickets: readonly Ticket[];
  readonly range: HarnessKpiRange;
  readonly reclaimRuns?: readonly ReclaimRunRecord[];
  readonly reclaimWindowMs?: number;
  /**
   * 誤回収件数 (reclaimedLiveWorktreeCount) の判定材料。git worktree/branch の
   * 現在のスキャン結果 (scanGitLeftovers)。未指定なら 0 になる。
   */
  readonly leftoverCandidates?: readonly LeftoverCandidate[];
}
