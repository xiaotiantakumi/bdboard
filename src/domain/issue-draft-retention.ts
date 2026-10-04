import type { DraftStatus } from './issue-draft.js';

/**
 * 不具合報告の下書きの保持期限と合計容量の方針 (bdboard-00qh、docs/ISSUE-REPORTING.md 4節
 * 「保持期限と合計容量」)。外部 I/O を持たない純粋な関数だけ。ファイルを測る・消すのは
 * infrastructure (fs-issue-draft-footprint.ts)、いつ走らせるかは application
 * (issue-draft-retention.ts)。
 *
 * 大原則: 利用者がまだ済ませていない下書きは自動では消さない。消してよいのは終端の状態
 * (dismissed・posted) で、しかも状態と最終更新時刻が確かに読めたものだけ。
 */

/** 見送り・投稿済みの下書きを、最後に更新されてからこの期間は残す。 */
export const ISSUE_DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 掃除 (期限切れの削除) を受け取りのついでに走らせる最短の間隔。起動時の掃除はこれを待たない。 */
export const ISSUE_DRAFT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 容量を測り直す (全下書きを stat する) 最短の間隔。上限に張り付いたまま暴走した呼び出しが、
 * 受け取りのたびに全件を測り直して CPU を食い続けないようにする。この間は、書き込みの差分で
 * 更新し続けている合計を信じる。
 */
export const ISSUE_DRAFT_RESURVEY_GAP_MS = 60 * 1000;

/**
 * 上限に張り付いた (測り直しても終端の下書きを消して空けられない) あいだ、測り直しの間隔を倍々に伸ばす上限
 * (bdboard-krvf)。1 GiB の最悪の形 (最大の draft.json 約 5,000 件) では棚卸し 1 回が 3〜8 秒かかり、その間
 * 受け取りは mutex で待つ。毎分では受け取りが毎分それだけ止まるので、空けられないあいだは 1 分 → 2 分 → 4 分 …
 * と伸ばし、この上限 (1 時間 = 掃除の間隔と同じ) で止める。空けられた・見送りがあった・掃除が空きを見つけたときは 1 分に戻す。
 */
export const ISSUE_DRAFT_RESURVEY_GAP_MAX_MS = 60 * 60 * 1000;

/**
 * issue-drafts ディレクトリ全体の既定の上限 (draft.json と画像の合計)。
 *
 * 1 GiB の根拠: 画像の上限 (1 枚 10MB × 20 枚) で 1 下書きが最大 200MB、draft.json は最大 200KiB
 * なので、1 GiB は「画像を目いっぱい付けた下書きが 5 件」か「最大サイズの draft.json が約 5,000 件」
 * に当たる。人が手で振り分ける量 (普通は数十件、1 件数 KB〜数十 KB) よりずっと大きく、暴走した hook
 * やエージェントのループが手元のディスクを埋める前に止まる大きさ。
 * 下書き 1 件の最小は約 1.3KB、1 時間の新規は最大 23 件 (個別 20 + 大量発生 3) なので、件数の上限としては
 * 効かない (件数は期限と受け取りの枠で抑える)。
 */
export const ISSUE_DRAFT_DIR_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * 1 つの下書きが、ディスク上でどれだけ場所を取っていて、自動で消してよいか。
 * `known` は draft.json が読めて stat もできたときだけ付く。無いものは状態を知らないので、
 * どの理由でも自動では消さない (読めない・壊れている・draft.json が無い・stat できない)。
 */
export interface DraftFootprint {
  readonly id: string;
  /** draft.json と画像の合計。測れなかった部分は 0 で数えている。 */
  readonly bytes: number;
  readonly known?: {
    readonly status: DraftStatus;
    /** draft.json の最終更新時刻 (保存のたびに進む。見送りも、回数だけ足す受け取りも保存する)。 */
    readonly updatedAtMs: number;
  };
}

/** 終端の状態 = 利用者が済ませた下書き。pending は含めない。 */
export function isTerminalDraftStatus(status: DraftStatus): boolean {
  return status === 'dismissed' || status === 'posted';
}

interface TerminalFootprint extends DraftFootprint {
  readonly known: NonNullable<DraftFootprint['known']>;
}

function terminalFootprints(drafts: readonly DraftFootprint[]): TerminalFootprint[] {
  return drafts.filter(
    (draft): draft is TerminalFootprint => draft.known !== undefined && isTerminalDraftStatus(draft.known.status),
  );
}

/**
 * 保持期限を過ぎた下書き: 終端の状態で、最終更新から retentionMs を**超えて**経ったもの。
 * ちょうど retentionMs の下書きは残す (「30 日より古い」)。
 */
export function selectExpiredDrafts(
  drafts: readonly DraftFootprint[],
  nowMs: number,
  retentionMs: number,
): DraftFootprint[] {
  return terminalFootprints(drafts).filter((draft) => nowMs - draft.known.updatedAtMs > retentionMs);
}

/**
 * 容量を空けるために消す下書き: 終端の状態のものを古い順 (最終更新、同じなら id) に、bytesToFree
 * 以上になるまで。終端の下書きを全部消しても足りなければ undefined (何も消さない: この書き込みは
 * どのみち収まらないので、消しても無駄になる)。
 */
export function selectDraftsToFree(drafts: readonly DraftFootprint[], bytesToFree: number): DraftFootprint[] | undefined {
  const oldestFirst = terminalFootprints(drafts).sort(
    (a, b) => a.known.updatedAtMs - b.known.updatedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const chosen: DraftFootprint[] = [];
  let freed = 0;
  for (const draft of oldestFirst) {
    if (freed >= bytesToFree) break;
    chosen.push(draft);
    freed += draft.bytes;
  }
  return freed >= bytesToFree ? chosen : undefined;
}
