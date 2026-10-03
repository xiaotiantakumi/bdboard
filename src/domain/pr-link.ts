import type { IssueComment } from './issue-comment.js';
import type { TicketId } from './ticket-id.js';

export type PrState = 'open' | 'merged' | 'closed';
export type PrCheckStatus = 'pass' | 'fail' | 'pending' | 'unknown';

export interface PrStatus {
  readonly state: PrState;
  readonly checkStatus: PrCheckStatus;
  /**
   * 修正 push 回数 = PR 作成後にコミットされたコミット数 (pr-fix-push.ts の
   * countPostCreateCommits。bdboard-p5l.27)。3 値で意味が違う:
   * - number: 取得できた値 (0 は「作成後の追加コミットなし」という確定値)。
   * - null: gh は応答したが createdAt/commits が読めなかった (= 不明で確定。再取得しない)。
   * - undefined (省略): この項目が入る前に取得・永続化された古いエントリ (= まだ試していない)。
   * バッジ表示 (PrBadgeDto) には出さず、統計 (get-model-stats) だけが読む。
   */
  readonly fixPushCount?: number | null;
}

export interface PrBadge {
  readonly ticketId: TicketId;
  readonly projectId: string;
  /**
   * コメントから抽出した最新の PR URL。null は「PR が無い」ではなく「まだ分からない」
   * を表す —— commentCount>0 のチケットの時間予算内にコメント走査が完了しなかった場合
   * (bdboard-3znc)。PR が無いと判明したチケットはそもそもバッジ自体を出さない
   * (getPrBadges の戻り値に含まれない)。
   */
  readonly url: string | null;
  /** gh呼び出しが成功して状態が分かったときだけ非null。取得不可/失敗時はnull(URLだけのバッジになる) */
  readonly status: PrStatus | null;
}

const PR_URL_PATTERN = /\bPR:\s*(\S+)/gi;

/** URL末尾に付く文章中の句読点・括弧などを除去する */
const TRAILING_URL_JUNK = /[.,;:)\]>】」』、。]+$/u;
const LEADING_URL_JUNK = /^[(<\[]+/u;

function normalizePrUrlCandidate(raw: string): string | null {
  let candidate = raw.replace(LEADING_URL_JUNK, '').replace(TRAILING_URL_JUNK, '');
  if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    return null;
  }
  return candidate;
}

/**
 * コメント本文から最新の `PR: <url>` を抽出する。
 * `comments` は CommentReader.listComments が createdAt 昇順で返す前提 —
 * 複数マッチ時は配列の後方(最新コメント側)のマッチを採用する。
 */
export function extractLatestPrUrl(
  comments: readonly Pick<IssueComment, 'text'>[],
): string | null {
  let latest: string | null = null;

  for (const comment of comments) {
    const pattern = new RegExp(PR_URL_PATTERN.source, PR_URL_PATTERN.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(comment.text)) !== null) {
      const candidate = match[1];
      if (candidate === undefined) {
        continue;
      }
      const normalized = normalizePrUrlCandidate(candidate);
      if (normalized !== null) {
        latest = normalized;
      }
    }
  }

  return latest;
}
