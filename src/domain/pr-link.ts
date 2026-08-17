import type { IssueComment } from './issue-comment.js';
import type { TicketId } from './ticket-id.js';

export type PrState = 'open' | 'merged' | 'closed';
export type PrCheckStatus = 'pass' | 'fail' | 'pending' | 'unknown';

export interface PrStatus {
  readonly state: PrState;
  readonly checkStatus: PrCheckStatus;
}

export interface PrBadge {
  readonly ticketId: TicketId;
  readonly projectId: string;
  readonly url: string;
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
