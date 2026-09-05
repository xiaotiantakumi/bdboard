/**
 * 「どのチケットを reclaim してよいか」を決める純関数 (bdboard-6aci)。
 *
 * ## なぜ要るのか
 *
 * `bd reclaim` が見ているのは lease だけで、**worktree もブランチも PR も見ない**。
 * 2026-09-05 に、heartbeat が途切れただけの生存セッションのチケット 4 件が claim の
 * 15〜19 分後に open へ戻された (bdboard-okdh / 53my / s0o7 / s1vj)。当人はそのまま
 * PR を出すので、台帳だけが「空き」と言い続ける。猶予窓の引き上げ (bdboard-hybu) は
 * 対症療法で、**回収してよいかの判断材料そのものを増やしてはいない**。
 *
 * ここでは worktree/ブランチの存在を「セッションがまだ生きている」証拠として扱い、
 * その証拠があるチケットを回収対象から外す。1 チケット = 1 worktree = 1 ブランチで、
 * それらは claim からマージ後の掃除までの間しか存在しない (docs/GIT-WORKFLOW.md)。
 *
 * ## 保護には上限を置く
 *
 * 証拠を無条件に信じると、**掃除し損ねた worktree が残っているだけのチケットが永久に
 * in_progress で塩漬けになる** — reclaim が本来防いでいた失敗形をそのまま復活させる。
 * よって保護は打ち切り時刻を持つ。基準は「作業開始からの経過時間」で、
 * `WORKTREE_PROTECTION_CAP_MS` を超えたら証拠があっても回収対象へ戻す。
 *
 * 打ち切りを「lease 失効からの経過」ではなく **startedAt からの経過**で測るのは、
 * lease の失効時刻が盤面キャッシュに載っていないため。startedAt から測ると保護は
 * 実際より短く切れる方向にしか外れない (claim 直後から時計が回るので)。回収漏れではなく
 * 「保護が早く切れる」側に倒れるのは、reclaim 本来の目的を損なわない安全側。
 */

/**
 * worktree/ブランチによる保護の上限。
 *
 * 12h の根拠: 実測された最長のチケット作業時間 (created → closed の中央値 186 分、
 * 最長でも数時間) を大きく上回り、かつ「昨日のセッションの残骸」を翌朝まで塩漬けに
 * しない長さ。これ以上長くすると reclaim が実質無効になり、短くすると保護が
 * 意味を失う。
 */
export const WORKTREE_PROTECTION_CAP_MS = 12 * 60 * 60_000;

export interface ReclaimPlanCandidate {
  readonly ticketId: string;
  /**
   * 作業開始時刻。保護の打ち切り判定にだけ使う。`startedAt` が無いチケット
   * (reclaim 済みだと bd が消す) は呼び出し側が `createdAt` で代用する。
   *
   * **`updatedAt` を代用に使わないこと。** コメント・メタデータ更新のたびに進むので、
   * 触り続けている限り保護が延び続ける (打ち切りたい向きと逆)。`createdAt` は
   * `startedAt` 以前なので、外れるとしても保護が早く切れる側にしか倒れない。
   */
  readonly startedAt: Date;
  /** worktree かブランチが実在する = セッションが生きている証拠 */
  readonly hasLiveWorktree: boolean;
}

export interface ReclaimPlan {
  /** `bd reclaim --id` に渡す ID。**空配列は「1件も回収しない」を意味する** */
  readonly reclaimTicketIds: readonly string[];
  /** 生存証拠があるので今回は外したチケット */
  readonly protectedTicketIds: readonly string[];
}

/**
 * 回収してよいチケットと、生存証拠で保護したチケットに振り分ける。
 *
 * **ここは「回収してよい候補」しか決めない。** lease が実際に失効しているかの判定は
 * bd 側 (`--older-than`) が持っており、`--id` は候補を狭めるだけで広げない
 * (`bd reclaim --help`: "Filters AND-combine and never widen the set")。
 */
export function planReclaim(
  candidates: readonly ReclaimPlanCandidate[],
  now: Date,
  protectionCapMs: number = WORKTREE_PROTECTION_CAP_MS,
): ReclaimPlan {
  const reclaimTicketIds: string[] = [];
  const protectedTicketIds: string[] = [];

  for (const candidate of candidates) {
    const elapsedMs = now.getTime() - candidate.startedAt.getTime();
    const protectedNow = candidate.hasLiveWorktree && elapsedMs <= protectionCapMs;
    if (protectedNow) {
      protectedTicketIds.push(candidate.ticketId);
    } else {
      reclaimTicketIds.push(candidate.ticketId);
    }
  }

  return { reclaimTicketIds, protectedTicketIds };
}
