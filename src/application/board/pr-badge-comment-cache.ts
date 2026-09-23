/**
 * PrBadgeCommentCache — チケットごとのコメント由来 PR URL を commentCount/updatedAt で
 * 無効化する薄いキャッシュ。get-pr-badges.ts から切り出した (bdboard-se3v: 挙動変更
 * ついでの行数上限対応。関心の分割のみ、ロジックは1文字も変えていない)。
 */
interface PrBadgeCommentCacheEntry {
  readonly commentCount: number;
  readonly updatedAt: number;
  readonly url: string | null;
  readonly hasCloseEvidence: boolean;
}

/** チケットごとのコメント由来 PR URL を commentCount/updatedAt で無効化する薄いキャッシュ。 */
export class PrBadgeCommentCache {
  private readonly entries = new Map<string, PrBadgeCommentCacheEntry>();

  get(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
  ): string | null | undefined {
    const entry = this.entries.get(ticketId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.commentCount === commentCount && entry.updatedAt === updatedAt) {
      return entry.url;
    }
    return undefined;
  }

  set(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
    url: string | null,
    hasCloseEvidence: boolean,
  ): void {
    this.entries.set(ticketId, {
      commentCount,
      updatedAt,
      url,
      hasCloseEvidence,
    });
  }

  /**
   * close 証拠 (コメントに PR:/検証: があるか) を、この PR バッジ用キャッシュから
   * 再利用する (bdboard-pkr6.16)。commentCount/updatedAt が一致しないエントリは
   * undefined (未確認)。
   *
   * 否定TTL は意図的に持たない (bdboard-pkr6.16 レビュー対応, M1)。pkr6.8 では
   * get-close-evidence.ts 自身が定期的に bd comments を叩き直す fetcher を持っており、
   * 否定結果に TTL を付けて「一定時間後に再フェッチさせる」ことで、既存コメントを
   * 編集して PR: を後付けしたケースを自己修復していた。本チケット (pkr6.16) で
   * その fetcher を丸ごと廃止したため、TTL 失効後にこのキャッシュへ書き込む
   * producer が存在しなくなった —— 一致する commentCount/updatedAt が来る
   * (新しいコメントが増える/元のコメントが編集されて updatedAt が動く) まで
   * 誰もここを更新しないので、TTL を残すと unknownKeys に落ちたまま二度と
   * 確定しなくなる = closed_without_evidence 警告が恒久的に沈黙する。
   * 「証拠なし」が事実と食い違ったまま多少長く残る (false positive 方向の劣化)
   * ほうが、警告が永久に出ない (false negative 方向) より衛生チェックとしては
   * はるかに安全な失敗方向なので、TTL は削除した。
   */
  getCloseEvidence(
    ticketId: string,
    commentCount: number,
    updatedAt: number,
  ): boolean | undefined {
    const entry = this.entries.get(ticketId);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.commentCount !== commentCount || entry.updatedAt !== updatedAt) {
      return undefined;
    }
    return entry.hasCloseEvidence;
  }

  prune(validTicketIds: ReadonlySet<string>): void {
    for (const ticketId of this.entries.keys()) {
      if (!validTicketIds.has(ticketId)) {
        this.entries.delete(ticketId);
      }
    }
  }
}
