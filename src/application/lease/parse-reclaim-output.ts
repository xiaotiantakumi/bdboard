import { isTicketId } from '../../domain/ticket-id.js';
import type { TicketId } from '../../domain/ticket-id.js';

export interface ParsedReclaimOutput {
  /** パース不能なら null */
  readonly count: number | null;
  readonly summary: string;
  /**
   * stdout から拾えた回収チケットID。bd reclaim の出力形式に保証は無いので
   * 「取れたら取る」扱い(拾えなければ空配列)。
   *
   * 形の似た普通の単語(`older-than` 等)も拾いうるが、これを使う側
   * (domain/harness-kpi.ts の computeReclaimKpi) が板面のチケットと突き合わせて
   * 一致した ID だけを指標の母数にするので、誤検出は率を歪めない。
   */
  readonly ticketIds: readonly TicketId[];
}

const RECLAIM_COUNT_PATTERNS: readonly RegExp[] = [
  /reclaimed\s+(\d+)\s+issue/i,
  /(\d+)\s+issue(?:s)?\s+reclaimed/i,
  /reclaimed\s+(\d+)/i,
];

/**
 * `prefix-shortId` 形。直前が `-` の候補は除く(`--older-than` のようなフラグを
 * 拾わないため)。
 */
const TICKET_ID_CANDIDATE =
  /(?<![\w./-])([A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)(?![\w-])/g;

function extractTicketIds(text: string): readonly TicketId[] {
  const pattern = new RegExp(TICKET_ID_CANDIDATE.source, TICKET_ID_CANDIDATE.flags);
  const seen = new Set<TicketId>();
  const ids: TicketId[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1];
    if (candidate === undefined || seen.has(candidate) || !isTicketId(candidate)) {
      continue;
    }
    seen.add(candidate);
    ids.push(candidate);
  }

  return ids;
}

/**
 * bd reclaim の stdout から回収件数と回収チケットIDを推定する。
 * 形式が変わった場合は count=null として summary のみ返す。
 */
export function parseReclaimStdout(stdout: string): ParsedReclaimOutput {
  const summary = stdout.trim();
  if (summary.length === 0) {
    return { count: 0, summary, ticketIds: [] };
  }

  const ticketIds = extractTicketIds(summary);

  for (const pattern of RECLAIM_COUNT_PATTERNS) {
    const match = summary.match(pattern);
    if (match !== null) {
      const parsed = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(parsed)) {
        return { count: parsed, summary, ticketIds };
      }
    }
  }

  return { count: null, summary, ticketIds };
}
